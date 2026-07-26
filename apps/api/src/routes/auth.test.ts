import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@mx2/config";
import type { NewAuditEvent } from "@mx2/core";
import type {
  AllowlistStore,
  AuditStore,
  ChallengeStore,
  InvitationRedeemResult,
  InvitationRow,
  InvitationStore,
  SessionStore,
  UserStore,
  WaitlistStore,
} from "@mx2/db";
import { hashInviteCode } from "../auth/invite-code.js";
import { registerAuthRoutes, type AuthRoutesDeps } from "./auth.js";

// A throwaway test key — never a real wallet.
const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
const ADDRESS = account.address.toLowerCase();

const NONCE = `0x${"ab".repeat(16)}`;
const ISSUED_AT = "2026-07-09T00:00:00.000Z";
const CHAIN_ID = 137;

/** Sign the login challenge exactly as the browser wallet would. */
const signLogin = () =>
  account.signTypedData({
    domain: { name: "MX2 Terminal", version: "1", chainId: BigInt(CHAIN_ID) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Login: [
        { name: "statement", type: "string" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "string" },
      ],
    },
    primaryType: "Login",
    message: { statement: "Sign in to MX2 Terminal", nonce: NONCE, issuedAt: ISSUED_AT },
  });

interface Harness {
  app: FastifyInstance;
  addCalls: { walletAddress: string; addedBy: string; note: string | null }[];
  audits: NewAuditEvent[];
  redeemCalls: { codeHash: string; walletAddress: string }[];
  waitlistStatusCalls: { id: string; status: string }[];
}

const INVITE_ID = "0f000000-0000-4000-8000-000000000001";
const WAITLIST_ID = "0f000000-0000-4000-8000-000000000002";

const makeInvitationRow = (over: Partial<InvitationRow> = {}): InvitationRow => ({
  id: INVITE_ID,
  codeHash: "stored-hash",
  issuedBy: "admin:owner",
  note: null,
  waitlistEntryId: null,
  expiresAt: new Date(Date.now() + 60_000),
  redeemedBy: null,
  redeemedAt: null,
  revokedAt: null,
  revokedBy: null,
  createdAt: new Date(),
  ...over,
});

const buildAuthApp = async (opts: {
  openBeta: boolean;
  alreadyAllowlisted: boolean;
  /** When set, an InvitationStore mock is wired that returns this from redeem. */
  redeemResult?: InvitationRedeemResult;
  /** Enable server-side signing to prove login STILL never provisions. */
  privySigning?: boolean;
}): Promise<Harness> => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...(opts.openBeta ? { FEATURE_OPEN_BETA: "true" } : {}),
    ...(opts.privySigning
      ? {
          FEATURE_PRIVY_SIGNING: "true",
          MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        }
      : {}),
  });

  const addCalls: Harness["addCalls"] = [];
  const audits: NewAuditEvent[] = [];

  const challenges: ChallengeStore = {
    create: async () => {
      throw new Error("not used");
    },
    findByNonce: async (nonce) =>
      nonce === NONCE
        ? {
            id: "chal-1",
            nonce: NONCE,
            walletAddress: ADDRESS,
            chainId: CHAIN_ID,
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
          }
        : null,
    markUsed: async () => {},
  };

  const allowlist: AllowlistStore = {
    isAllowed: async () => opts.alreadyAllowlisted,
    findEntry: async () => null,
    add: async (walletAddress, addedBy, note) => {
      addCalls.push({ walletAddress, addedBy, note });
      return {
        walletAddress,
        addedBy,
        note,
        isActive: true,
        addedAt: new Date(),
        removedAt: null,
      };
    },
    remove: async () => {},
  };

  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push(e);
      return { ...e, subject: e.subject ?? null, id: "audit-1", createdAt: new Date() };
    },
    recent: async () => [],
    forActor: async () => [],
    forSubject: async () => [],
  };

  const users: UserStore = {
    upsert: async (w) => ({ walletAddress: w, createdAt: new Date(), lastSeenAt: new Date() }),
    findByWallet: async () => null,
  };

  const sessions: SessionStore = {
    create: async (o) => ({
      id: "sess-1",
      userWallet: o.userWallet,
      tokenHash: o.tokenHash,
      expiresAt: o.expiresAt,
      scope: null,
      createdAt: new Date(),
      revokedAt: null,
    }),
    findByTokenHash: async () => null,
    revoke: async () => {},
    revokeAllForWallet: async () => 0,
  };

  const redeemCalls: Harness["redeemCalls"] = [];
  const waitlistStatusCalls: Harness["waitlistStatusCalls"] = [];

  const invitations: InvitationStore | undefined = opts.redeemResult
    ? {
        create: async () => {
          throw new Error("not used");
        },
        findById: async () => null,
        findByCodeHash: async () => null,
        redeem: async (codeHash, walletAddress) => {
          redeemCalls.push({ codeHash, walletAddress });
          return opts.redeemResult!;
        },
        revoke: async () => null,
        list: async () => [],
      }
    : undefined;

  const waitlist: WaitlistStore | undefined = opts.redeemResult
    ? {
        submit: async () => {
          throw new Error("not used");
        },
        list: async () => [],
        findById: async () => null,
        updateStatus: async (id, status) => {
          waitlistStatusCalls.push({ id, status });
          return null;
        },
      }
    : undefined;

  const deps: AuthRoutesDeps = {
    config,
    challenges,
    users,
    sessions,
    allowlist,
    auditStore,
    ...(invitations ? { invitations } : {}),
    ...(waitlist ? { waitlist } : {}),
  };

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerAuthRoutes(app, deps);
  return { app, addCalls, audits, redeemCalls, waitlistStatusCalls };
};

const verifyBody = async () => ({
  address: ADDRESS,
  nonce: NONCE,
  issuedAt: ISSUED_AT,
  signature: await signLogin(),
});

describe("POST /api/auth/verify — open-beta auto-allowlist", () => {
  it("still 403s unknown wallets when FEATURE_OPEN_BETA is off", async () => {
    const { app, addCalls } = await buildAuthApp({ openBeta: false, alreadyAllowlisted: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "NOT_ALLOWLISTED" });
    expect(addCalls).toHaveLength(0);
    await app.close();
  });

  it("auto-allowlists a valid unknown wallet when FEATURE_OPEN_BETA is on", async () => {
    const { app, addCalls, audits } = await buildAuthApp({
      openBeta: true,
      alreadyAllowlisted: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, address: ADDRESS });
    expect(addCalls).toEqual([
      {
        walletAddress: ADDRESS,
        addedBy: "system:open-beta",
        note: "auto-allowlisted (open beta)",
      },
    ]);
    expect(audits.map((a) => a.action)).toContain("allowlist.auto_added");
    // Session cookie must be set — the wallet is signed in immediately.
    expect(res.headers["set-cookie"]).toBeDefined();
    await app.close();
  });

  it("never auto-allowlists on an invalid signature", async () => {
    const { app, addCalls } = await buildAuthApp({ openBeta: true, alreadyAllowlisted: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), signature: `0x${"11".repeat(65)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(addCalls).toHaveLength(0);
    await app.close();
  });

  it("does not re-add wallets that are already allowlisted", async () => {
    const { app, addCalls, audits } = await buildAuthApp({
      openBeta: true,
      alreadyAllowlisted: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(addCalls).toHaveLength(0);
    expect(audits.map((a) => a.action)).not.toContain("allowlist.auto_added");
    await app.close();
  });

  it("never provisions an Arima trading wallet on login (even with privy signing on)", async () => {
    const { app, audits } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: true,
      privySigning: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(200);
    // Arima Wallet is an explicit opt-in (brief §5.3.5): login emits auth.login
    // but no trading-wallet provisioning side effect of any kind.
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("auth.login");
    expect(actions.some((a) => a.startsWith("trading_wallet."))).toBe(false);
    expect(actions).not.toContain("trading_account.unarchived");
    await app.close();
  });
});

describe("POST /api/auth/verify — private-beta invitation redemption", () => {
  it("redeems a valid code for the signing wallet, allowlists it, and signs in", async () => {
    const row = makeInvitationRow({ waitlistEntryId: WAITLIST_ID });
    const { app, addCalls, audits, redeemCalls, waitlistStatusCalls } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      redeemResult: { outcome: "redeemed", invitation: row },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "arima-cafe" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, address: ADDRESS });
    // Redemption is bound server-side to the signature-verified wallet and
    // the code is hashed before it touches the store.
    expect(redeemCalls).toEqual([
      { codeHash: hashInviteCode("arima-cafe"), walletAddress: ADDRESS },
    ]);
    expect(addCalls).toEqual([
      { walletAddress: ADDRESS, addedBy: `invite:${INVITE_ID}`, note: null },
    ]);
    expect(audits.map((a) => a.action)).toContain("invite.redeemed");
    expect(waitlistStatusCalls).toEqual([{ id: WAITLIST_ID, status: "accepted" }]);
    expect(res.headers["set-cookie"]).toBeDefined();
    await app.close();
  });

  it("treats a replay by the same wallet as idempotent success", async () => {
    const row = makeInvitationRow({ redeemedBy: ADDRESS, redeemedAt: new Date() });
    const { app, audits } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      redeemResult: { outcome: "already_redeemed_by_wallet", invitation: row },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "arima-cafe" },
    });
    expect(res.statusCode).toBe(200);
    const redeemed = audits.find((a) => a.action === "invite.redeemed");
    expect(redeemed?.metadata).toMatchObject({ idempotentReplay: true });
    await app.close();
  });

  it("rejects an invalid/expired/foreign code with 403 INVITE_INVALID and audits it", async () => {
    const { app, addCalls, audits } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      redeemResult: { outcome: "rejected", reason: "redeemed_by_other" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "arima-stolen" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "INVITE_INVALID" });
    expect(addCalls).toHaveLength(0);
    const rejected = audits.find((a) => a.action === "invite.redemption_rejected");
    expect(rejected?.metadata).toMatchObject({ reason: "redeemed_by_other" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("never attempts redemption on an invalid signature", async () => {
    const { app, redeemCalls } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      redeemResult: { outcome: "redeemed", invitation: makeInvitationRow() },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        ...(await verifyBody()),
        signature: `0x${"11".repeat(65)}`,
        inviteCode: "arima-cafe",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(redeemCalls).toHaveLength(0);
    await app.close();
  });

  it("403 without a code advertises the waitlist and invite paths", async () => {
    const { app } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      redeemResult: { outcome: "rejected", reason: "not_found" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "NOT_ALLOWLISTED",
      inviteRedemptionAvailable: true,
      waitlistAvailable: true,
    });
    await app.close();
  });
});
