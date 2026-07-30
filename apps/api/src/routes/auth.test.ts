import { describe, it, expect, beforeEach } from "vitest";
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
  ReferralCodeRow,
  ReferralRedeemResult,
  ReferralRedemptionRow,
  ReferralStore,
  SessionStore,
  UserStore,
  WaitlistStore,
} from "@mx2/db";
import { hashInviteCode } from "../auth/invite-code.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { registerAuthRoutes, type AuthRoutesDeps } from "./auth.js";

// The verify endpoint is rate-limited per IP; app.inject always uses the same
// IP, so the counter must not leak across tests.
beforeEach(() => resetRateLimits());

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
  referralRedeemCalls: { rawCode: string; walletAddress: string }[];
  ensurePersonalCalls: string[];
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

const REFERRAL_CODE_ID = "0f000000-0000-4000-8000-000000000003";

const makeReferralCodeRow = (over: Partial<ReferralCodeRow> = {}): ReferralCodeRow => ({
  id: REFERRAL_CODE_ID,
  code: "ANSEM",
  ownerWallet: `0x${"9".repeat(40)}`,
  maxUses: 5,
  usedCount: 1,
  note: null,
  createdBy: "admin:owner",
  expiresAt: null,
  disabledAt: null,
  disabledBy: null,
  createdAt: new Date(),
  ...over,
});

const makeReferralRedemptionRow = (
  over: Partial<ReferralRedemptionRow> = {},
): ReferralRedemptionRow => ({
  id: "0f000000-0000-4000-8000-000000000004",
  codeId: REFERRAL_CODE_ID,
  walletAddress: ADDRESS,
  referrerWallet: `0x${"9".repeat(40)}`,
  redeemedAt: new Date(),
  ...over,
});

const buildAuthApp = async (opts: {
  openBeta: boolean;
  alreadyAllowlisted: boolean;
  /** When set, an InvitationStore mock is wired that returns this from redeem. */
  redeemResult?: InvitationRedeemResult;
  /** When set, a ReferralStore mock is wired that returns this from redeem. */
  referralRedeemResult?: ReferralRedeemResult;
  /** Puts the test wallet into ADMIN_WALLET_ADDRESSES (drives /me.isAdmin). */
  adminWallet?: boolean;
  /** Makes ensurePersonalCode throw — login must still succeed. */
  personalCodeFails?: boolean;
  /** Enable server-side signing to prove login STILL never provisions. */
  privySigning?: boolean;
}): Promise<Harness> => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    // Explicit both ways: the config default is now open-beta ON (public
    // release), so gated-path tests must pin it off rather than rely on it.
    FEATURE_OPEN_BETA: opts.openBeta ? "true" : "false",
    ...(opts.adminWallet ? { ADMIN_WALLET_ADDRESSES: ADDRESS } : {}),
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
    // Any presented cookie resolves to a full session for the test wallet —
    // routes under requireAuth (/me) can then be exercised directly.
    findByTokenHash: async (tokenHash) => ({
      id: "sess-1",
      userWallet: ADDRESS,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      scope: null,
      createdAt: new Date(),
      revokedAt: null,
    }),
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

  const referralRedeemCalls: Harness["referralRedeemCalls"] = [];
  const ensurePersonalCalls: string[] = [];
  const notUsed = () => {
    throw new Error("not used");
  };
  const referrals: ReferralStore | undefined = opts.referralRedeemResult
    ? {
        ensurePersonalCode: async (wallet) => {
          if (opts.personalCodeFails) throw new Error("mint failed");
          ensurePersonalCalls.push(wallet);
          return makeReferralCodeRow({ ownerWallet: wallet, createdBy: "system:auto" });
        },
        redeem: async (rawCode, walletAddress) => {
          referralRedeemCalls.push({ rawCode, walletAddress });
          return opts.referralRedeemResult!;
        },
        createCode: notUsed,
        findById: async () => null,
        findByCode: async () => null,
        codesForOwner: async () => [],
        setMaxUses: async () => null,
        setNote: async () => null,
        setDisabled: async () => null,
        reassignOwner: async () => null,
        list: async () => [],
        redemptionsForCode: async () => [],
        redemptionForWallet: async () => null,
        listRedemptions: async () => [],
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
    ...(referrals ? { referrals } : {}),
  };

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerAuthRoutes(app, deps);
  return {
    app,
    addCalls,
    audits,
    redeemCalls,
    waitlistStatusCalls,
    referralRedeemCalls,
    ensurePersonalCalls,
  };
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

describe("POST /api/auth/verify — referral code redemption", () => {
  it("redeems a referral code, allowlists, audits, and mints a personal code", async () => {
    const { app, addCalls, audits, referralRedeemCalls, ensurePersonalCalls } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: {
        outcome: "redeemed",
        code: makeReferralCodeRow(),
        redemption: makeReferralRedemptionRow(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "ansem" },
    });
    expect(res.statusCode).toBe(200);
    expect(referralRedeemCalls).toEqual([{ rawCode: "ansem", walletAddress: ADDRESS }]);
    expect(addCalls).toEqual([
      { walletAddress: ADDRESS, addedBy: `referral:${REFERRAL_CODE_ID}`, note: "ANSEM" },
    ]);
    expect(audits.some((a) => a.action === "referral.redeemed")).toBe(true);
    expect(ensurePersonalCalls).toEqual([ADDRESS]);
    await app.close();
  });

  it("rejects an exhausted code without leaking seat counts", async () => {
    const { app, addCalls, audits } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: { outcome: "rejected", reason: "exhausted" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "ANSEM" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "INVITE_INVALID" });
    expect(addCalls).toHaveLength(0);
    expect(audits.some((a) => a.action === "referral.redemption_rejected")).toBe(true);
    await app.close();
  });

  it("tells an already-referred wallet to contact support", async () => {
    const { app } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: { outcome: "rejected", reason: "wallet_already_referred" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "OTHER" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("already used a referral code");
    await app.close();
  });

  it("falls back to a legacy hashed invitation when the referral code is unknown", async () => {
    const { app, addCalls, redeemCalls, referralRedeemCalls } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: { outcome: "rejected", reason: "not_found" },
      redeemResult: {
        outcome: "redeemed",
        invitation: makeInvitationRow({ redeemedBy: ADDRESS, redeemedAt: new Date() }),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "arima-cafe" },
    });
    expect(res.statusCode).toBe(200);
    expect(referralRedeemCalls).toHaveLength(1);
    expect(redeemCalls).toEqual([
      { codeHash: hashInviteCode("arima-cafe"), walletAddress: ADDRESS },
    ]);
    expect(addCalls).toEqual([
      { walletAddress: ADDRESS, addedBy: `invite:${INVITE_ID}`, note: null },
    ]);
    await app.close();
  });

  it("403s an unknown code in a referral-only deployment", async () => {
    const { app, audits } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: { outcome: "rejected", reason: "not_found" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "NOPE" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "INVITE_INVALID" });
    expect(
      audits.some(
        (a) =>
          a.action === "referral.redemption_rejected" && a.metadata?.["reason"] === "not_found",
      ),
    ).toBe(true);
    await app.close();
  });

  it("never consumes a code for an already-allowlisted wallet", async () => {
    const { app, referralRedeemCalls, ensurePersonalCalls } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: true,
      referralRedeemResult: { outcome: "rejected", reason: "exhausted" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...(await verifyBody()), inviteCode: "ANSEM" },
    });
    expect(res.statusCode).toBe(200);
    expect(referralRedeemCalls).toHaveLength(0);
    // Grandfathered wallets still get their personal code lazily.
    expect(ensurePersonalCalls).toEqual([ADDRESS]);
    await app.close();
  });

  it("survives a personal-code minting failure (login is never blocked)", async () => {
    const { app } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: true,
      referralRedeemResult: { outcome: "rejected", reason: "not_found" },
      personalCodeFails: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: await verifyBody(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rate-limits repeated verify attempts from one IP", async () => {
    const { app } = await buildAuthApp({
      openBeta: false,
      alreadyAllowlisted: false,
      referralRedeemResult: { outcome: "rejected", reason: "not_found" },
    });
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: { address: ADDRESS, nonce: NONCE, issuedAt: ISSUED_AT, signature: "0x00" },
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    await app.close();
  });
});

describe("GET /api/auth/me — isAdmin flag", () => {
  it("reports isAdmin=true only for configured admin wallets", async () => {
    for (const adminWallet of [true, false]) {
      const { app } = await buildAuthApp({
        openBeta: false,
        alreadyAllowlisted: true,
        adminWallet,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [SESSION_COOKIE_NAME]: "any-token" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().isAdmin).toBe(adminWallet);
      await app.close();
    }
  });
});
