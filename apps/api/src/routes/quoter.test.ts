import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { ok } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import type {
  AuditStore,
  QuoteSessionRow,
  QuoterStore,
  RuleStore,
  SessionRow,
  SessionStore,
} from "@mx2/db";
import type { ClobClient, GammaClient, GeoblockClient } from "@mx2/polymarket-client";
import { registerQuoterRoutes } from "./quoter.js";

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const RULE = "3a8e1a67-0000-4000-8000-000000000001";

const configLive = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: "a".repeat(64),
  TRADING_ADMIN_SECRET: "test-admin-secret-123",
  FEATURE_MAKER_LOOP: "true",
  FEATURE_MAKER_LOOP_LIVE: "true",
  FEATURE_LIVE_TRADING: "true",
  FEATURE_PRIVY_SIGNING: "true",
  FEATURE_RELAYER: "true",
  MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  POLYGON_RPC_URL: "https://polygon.example.test",
  POLYMARKET_RELAYER_URL: "https://relayer.example.test",
  POLYMARKET_BUILDER_API_KEY: "k",
  POLYMARKET_BUILDER_SECRET: "s",
  POLYMARKET_BUILDER_PASSPHRASE: "p",
  CTF_ADAPTER_ADDRESS: "0x1111111111111111111111111111111111111111",
  NEG_RISK_CTF_ADAPTER_ADDRESS: "0x2222222222222222222222222222222222222222",
});

const sessRow = (): SessionRow => ({
  id: "sess-id",
  userWallet: WALLET,
  tokenHash: "hash",
  expiresAt: new Date(Date.now() + 1_000_000),
  createdAt: new Date(),
  revokedAt: null,
});

const sessionsAuthed: SessionStore = {
  create: async () => sessRow(),
  findByTokenHash: async () => sessRow(),
  revoke: async () => {},
};

const makeSession = (over: Partial<QuoteSessionRow> = {}): QuoteSessionRow =>
  ({
    id: "qs-1",
    ruleId: RULE,
    walletAddress: WALLET,
    mode: "confirm",
    status: "quoting",
    haltedReason: null,
    inventoryYes: "0",
    inventoryNo: "0",
    inventoryYesCostUsd: "0",
    inventoryNoCostUsd: "0",
    capitalCommittedUsd: "0",
    realizedPnlUsd: "0",
    dailyLossUsd: "0",
    rewardsAccruedUsd: "0",
    dailyLossDay: null,
    pendingBatch: { places: [], mergePairs: 25 },
    pendingBatchHash: "b".repeat(64),
    pendingBatchAt: new Date(),
    approvedBatchHash: null,
    approvedAt: null,
    lastCycleAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as QuoteSessionRow;

const buildApp = (
  over: {
    session?: QuoteSessionRow;
    geoBlocked?: boolean;
    cfg?: ReturnType<typeof loadConfig>;
    /** Optional readiness-panel deps (loosely typed mocks). */
    readiness?: Record<string, unknown>;
  } = {},
) => {
  const session = over.session ?? makeSession();
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const approvals: string[] = [];
  const modeSets: string[] = [];
  const quoterStore = {
    findSessionByRuleId: async () => session,
    approveBatch: async (_id: string, hash: string) => {
      if (session.pendingBatchHash !== hash) return null;
      approvals.push(hash);
      return { ...session, approvedBatchHash: hash };
    },
    setMode: async (_id: string, mode: string) => {
      modeSets.push(mode);
      return { ...session, mode };
    },
    updateSession: async () => session,
    listEvents: async () => [],
  } as unknown as QuoterStore;
  const app = Fastify();
  void app.register(fastifyCookie);
  registerQuoterRoutes(app, {
    config: over.cfg ?? configLive,
    sessions: sessionsAuthed,
    ruleStore: {
      findByIdForWallet: async () => ({ id: RULE, walletAddress: WALLET }) as never,
    } as unknown as RuleStore,
    quoterStore,
    auditStore: {
      emit: async (e) => {
        audits.push({ action: e.action, metadata: e.metadata });
        return {} as never;
      },
      recent: async () => [],
      forActor: async () => [],
    } as AuditStore,
    gammaClient: {} as GammaClient,
    clobClient: {} as ClobClient,
    geoblockClient: {
      check: async () =>
        ok({
          status: over.geoBlocked ? ("blocked" as const) : ("allowed" as const),
          blocked: over.geoBlocked ?? false,
          country: "AE",
          region: "",
        }),
    } as unknown as GeoblockClient,
    ...((over.readiness ?? {}) as object),
  });
  return { app, audits, approvals, modeSets, session };
};

const post = (
  app: ReturnType<typeof Fastify>,
  url: string,
  payload: Record<string, unknown> = {},
) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: "mx2_session=tok", "content-type": "application/json" },
    payload,
  });

describe("GET /api/quoter/readiness (B7 — presence booleans, never values)", () => {
  it("reports flag/wallet/allowance state without leaking a single credential", async () => {
    const { app } = buildApp({
      readiness: {
        privyWallets: {
          find: async () => ({
            walletAddress: WALLET,
            privyWalletId: "pw-1",
            embeddedAddress: "0x1111111111111111111111111111111111111111",
          }),
        },
        tradingAccounts: {
          listByOwner: async () => [
            {
              id: "acct-1",
              kind: "internal_privy",
              archivedAt: null,
              signerAddress: "0x1111111111111111111111111111111111111111",
              depositWalletAddress: "0x9999999999999999999999999999999999999999",
            },
          ],
        },
        accountClobCredentials: {
          find: async () => ({ encryptedCreds: { v: 1, iv: "SECRET_IV", data: "SECRET_DATA" } }),
        },
        allowanceReader: {
          erc20Allowance: async () => 2n ** 255n,
          isApprovedForAll: async () => true,
          erc20Balance: async () => 0n,
        },
        relayerEnabled: true,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/quoter/readiness",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "adapters",
      "allowances",
      "flags",
      "geoblock",
      "relayerEnabled",
      "rpcConfigured",
      "wallet",
    ]);
    expect(body.wallet).toEqual({
      provisioned: true,
      depositWalletActive: true,
      clobCredentials: true,
    });
    expect((body.allowances as unknown[]).length).toBeGreaterThan(0);
    for (const a of body.allowances as Record<string, unknown>[]) {
      expect(a.granted).toBe(true);
    }
    // The no-leak assertion: nothing from the encrypted credential row (or any
    // secret-looking material) may appear anywhere in the payload.
    const raw = res.body;
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("encryptedCreds");
    expect(raw).not.toContain("pw-1");
    await app.close();
  });
});

describe("POST /api/quoter/sessions/:ruleId/confirm (B4 confirm protocol)", () => {
  it("approves the CURRENT pending batch and audits it", async () => {
    const { app, audits, approvals, session } = buildApp();
    const res = await post(app, `/api/quoter/sessions/${RULE}/confirm`, {
      batchHash: session.pendingBatchHash,
    });
    expect(res.statusCode).toBe(200);
    expect(approvals).toEqual([session.pendingBatchHash]);
    expect(audits.map((a) => a.action)).toContain("quoter.batch_approved");
    await app.close();
  });

  it("409s BATCH_STALE when the proposal has moved on", async () => {
    const { app, approvals } = buildApp();
    const res = await post(app, `/api/quoter/sessions/${RULE}/confirm`, {
      batchHash: "c".repeat(64),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("BATCH_STALE");
    expect(approvals).toHaveLength(0);
    await app.close();
  });

  it("409s WRONG_MODE outside confirm mode", async () => {
    const { app } = buildApp({ session: makeSession({ mode: "shadow" } as never) });
    const res = await post(app, `/api/quoter/sessions/${RULE}/confirm`, {
      batchHash: "b".repeat(64),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("WRONG_MODE");
    await app.close();
  });

  it("geoblocks every approval (fail-closed)", async () => {
    const { app, approvals, session } = buildApp({ geoBlocked: true });
    const res = await post(app, `/api/quoter/sessions/${RULE}/confirm`, {
      batchHash: session.pendingBatchHash,
    });
    expect(res.statusCode).toBe(403);
    expect(approvals).toHaveLength(0);
    await app.close();
  });
});

describe("POST /api/quoter/sessions/:ruleId/mode (escalation guards)", () => {
  it("geoblocks escalation out of shadow", async () => {
    const { app, modeSets } = buildApp({
      session: makeSession({ mode: "shadow" } as never),
      geoBlocked: true,
    });
    const res = await post(app, `/api/quoter/sessions/${RULE}/mode`, { mode: "confirm" });
    expect(res.statusCode).toBe(403);
    expect(modeSets).toHaveLength(0);
    await app.close();
  });

  it("allows escalation when geoblock passes", async () => {
    const { app, modeSets } = buildApp({ session: makeSession({ mode: "shadow" } as never) });
    const res = await post(app, `/api/quoter/sessions/${RULE}/mode`, { mode: "confirm" });
    expect(res.statusCode).toBe(200);
    expect(modeSets).toEqual(["confirm"]);
    await app.close();
  });

  it("refuses live→shadow while the session is not halted (HALT_BEFORE_SHADOW)", async () => {
    const { app, modeSets } = buildApp({
      session: makeSession({ mode: "live", status: "quoting" } as never),
    });
    const res = await post(app, `/api/quoter/sessions/${RULE}/mode`, { mode: "shadow" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("HALT_BEFORE_SHADOW");
    expect(modeSets).toHaveLength(0);
    await app.close();
  });

  it("allows live→shadow once halted", async () => {
    const { app, modeSets } = buildApp({
      session: makeSession({ mode: "live", status: "halted" } as never),
    });
    const res = await post(app, `/api/quoter/sessions/${RULE}/mode`, { mode: "shadow" });
    expect(res.statusCode).toBe(200);
    expect(modeSets).toEqual(["shadow"]);
    await app.close();
  });
});
