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
  PrivyWalletStore,
  SessionStore,
  TradingAccountStore,
  UserStore,
} from "@mx2/db";
import { createMockTradingSigner } from "@mx2/trading-signer";
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
}

const buildAuthApp = async (opts: {
  openBeta: boolean;
  alreadyAllowlisted: boolean;
}): Promise<Harness> => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...(opts.openBeta ? { FEATURE_OPEN_BETA: "true" } : {}),
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
      createdAt: new Date(),
      revokedAt: null,
    }),
    findByTokenHash: async () => null,
    revoke: async () => {},
  };

  const privyWallets: PrivyWalletStore = {
    upsert: async () => {
      throw new Error("not used");
    },
    find: async () => null,
    markAllowancesBootstrapped: async () => {},
  };

  const tradingAccounts = {
    upsertExternal: async () => {
      throw new Error("not used");
    },
    upsertInternalPrivy: async () => {
      throw new Error("not used");
    },
    list: async () => [],
    findById: async () => null,
    findPrimary: async () => null,
    setPrimary: async () => null,
    archive: async () => null,
  } as unknown as TradingAccountStore;

  const deps: AuthRoutesDeps = {
    config,
    challenges,
    users,
    sessions,
    allowlist,
    auditStore,
    tradingSigner: createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` }),
    privyWallets,
    tradingAccounts,
  };

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerAuthRoutes(app, deps);
  return { app, addCalls, audits };
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
});
