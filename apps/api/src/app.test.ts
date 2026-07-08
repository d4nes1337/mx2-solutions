import { describe, it, expect } from "vitest";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  MarketSnapshotStore,
  ChallengeStore,
  UserStore,
  SessionStore,
  AllowlistStore,
  ClobCredentialStore,
  OrderIntentStore,
  RuntimeFlagStore,
  RuleStore,
  TriggerStore,
  PrivyWalletStore,
  DelegationStore,
  AuthChallengeRow,
  UserRow,
  SessionRow,
  AllowlistRow,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
  PolymarketError,
} from "@mx2/polymarket-client";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import { buildApp, type DbProbe } from "./app.js";

const config = loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" });
const logger = createLogger({ name: "api-test", level: "silent" });

const upstreamErr: PolymarketError = {
  code: "UPSTREAM_ERROR",
  message: "not found",
  statusCode: 404,
};

const mockGammaClient: GammaClient = {
  listEvents: async () => ok([]),
  getEvent: async () => err(upstreamErr),
  listMarkets: async () => ok([]),
  getMarket: async () => err(upstreamErr),
  getPublicProfile: async () => ok(null),
  findMarket: async () => ok(null),
  searchMarkets: async () => ok([]),
};

const mockClobClient: ClobClient = {
  getOrderbook: async () => err(upstreamErr),
  getTrades: async () => ok([]),
  getPrices: async () => ok([]),
  getLastTradePrice: async () => err(upstreamErr),
  getPricesHistory: async () => ok([]),
};

const mockDataClient: DataClient = {
  getPositions: async () => ok([]),
  getClosedPositions: async () => ok([]),
  getActivity: async () => ok([]),
  getPositionValue: async () => ok(null),
  getLeaderboardEntry: async () => ok(null),
};

const mockMarketSnapshots: MarketSnapshotStore = {
  upsert: async () => {
    throw new Error("not implemented in test");
  },
  findByTokenId: async () => null,
  markStale: async () => {},
};

const mockAuditStore: AuditStore = {
  emit: async (e) => ({
    id: "test-id",
    actor: e.actor,
    action: e.action,
    subject: e.subject ?? null,
    metadata: e.metadata,
    createdAt: new Date(),
  }),
  recent: async () => [],
  forActor: async () => [],
};

const mockChallenges: ChallengeStore = {
  create: async () => {
    throw new Error("not implemented in test");
  },
  findByNonce: async () => null,
  markUsed: async () => {},
};

const mockUsers: UserStore = {
  upsert: async (w) =>
    ({
      walletAddress: w,
      createdAt: new Date(),
      lastSeenAt: new Date(),
    }) satisfies UserRow,
  findByWallet: async () => null,
};

const makeSessionRow = (walletAddress: string): SessionRow => ({
  id: "sess-id",
  userWallet: walletAddress,
  tokenHash: "hash",
  expiresAt: new Date(Date.now() + 1_000_000),
  createdAt: new Date(),
  revokedAt: null,
});

const mockSessions: SessionStore = {
  create: async (o) => makeSessionRow(o.userWallet),
  findByTokenHash: async () => null,
  revoke: async () => {},
};

const mockAllowlist: AllowlistStore = {
  isAllowed: async () => false,
  findEntry: async () => null,
  add: async (w, by, note) =>
    ({
      walletAddress: w,
      addedBy: by,
      note: note ?? null,
      isActive: true,
      addedAt: new Date(),
      removedAt: null,
    }) satisfies AllowlistRow,
  remove: async () => {},
};

const mockClobCredentials: ClobCredentialStore = {
  upsert: async () => {
    throw new Error("not implemented in test");
  },
  find: async () => null,
  delete: async () => {},
};

const mockOrderIntents: OrderIntentStore = {
  create: async () => {
    throw new Error("not implemented in test");
  },
  findByIdempotencyKey: async () => null,
  findById: async () => null,
  listByWallet: async () => [],
  updateStatus: async () => {},
  countRecentByWallet: async () => 0,
  sumRuleAutoNotional: async () => 0,
};

const mockRuntimeFlags: RuntimeFlagStore = {
  get: async () => null,
  set: async (key, value, updatedBy) => ({ key, value, updatedBy, updatedAt: new Date() }),
};

const mockRuleStore: RuleStore = {
  create: async () => {
    throw new Error("not implemented in test");
  },
  findById: async () => null,
  findByIdForWallet: async () => null,
  listByWallet: async () => [],
  listEvaluable: async () => [],
  updateEvaluationState: async () => null,
  pause: async () => null,
  resume: async () => null,
  cancel: async () => null,
  markExecuted: async () => null,
  markExecuting: async () => null,
  markAutoExecuted: async () => null,
  markExecutionFailed: async () => null,
  addExecutedNotional: async () => {},
};

const mockTriggerStore: TriggerStore = {
  create: async () => {
    throw new Error("not implemented in test");
  },
  findById: async () => null,
  findByIdForWallet: async () => null,
  listByWallet: async () => [],
  listAwaiting: async () => [],
  hasForRule: async () => false,
  updateStatus: async () => {},
};

const mockTradingClobClient: AuthenticatedClobClient = {
  getServerTime: async () => ok(Math.floor(Date.now() / 1000)),
  deriveApiKey: async () => err(upstreamErr),
  getBalanceAllowance: async () => err(upstreamErr),
  submitOrder: async () => err(upstreamErr),
  cancelOrder: async () => err(upstreamErr),
  getOpenOrders: async () => ok([]),
};

const mockGeoblockClient: GeoblockClient = {
  check: async (ip) => ok({ status: "allowed", country: "DE", region: null, ip }),
};

const mockTradingSigner: TradingSigner = createMockTradingSigner({
  privateKey: `0x${"1".repeat(64)}`,
});

const mockPrivyWallets: PrivyWalletStore = {
  upsert: async () => {
    throw new Error("not implemented");
  },
  find: async () => null,
  markAllowancesBootstrapped: async () => {},
};

const mockDelegations: DelegationStore = {
  create: async () => {
    throw new Error("not implemented");
  },
  findActive: async () => null,
  revoke: async () => {},
  expireLapsed: async () => {},
};

const appWith = (db: DbProbe, overrides?: Partial<typeof mockSessions & typeof mockAllowlist>) =>
  buildApp({
    config,
    logger,
    db,
    auditStore: mockAuditStore,
    gammaClient: mockGammaClient,
    clobClient: mockClobClient,
    dataClient: mockDataClient,
    marketSnapshots: mockMarketSnapshots,
    challenges: mockChallenges,
    users: mockUsers,
    sessions: { ...mockSessions, ...overrides },
    allowlist: mockAllowlist,
    clobCredentials: mockClobCredentials,
    orderIntents: mockOrderIntents,
    runtimeFlags: mockRuntimeFlags,
    ruleStore: mockRuleStore,
    triggerStore: mockTriggerStore,
    tradingClobClient: mockTradingClobClient,
    tradingSigner: mockTradingSigner,
    privyWallets: mockPrivyWallets,
    delegations: mockDelegations,
    geoblockClient: mockGeoblockClient,
  });

describe("health endpoints", () => {
  it("GET /healthz returns ok regardless of downstreams", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", env: "development" });
    await app.close();
  });

  it("GET /readyz returns 200 when db is up", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", checks: { db: "up" } });
    await app.close();
  });

  it("GET /readyz returns 503 when db is down", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { db: "down" } });
    await app.close();
  });

  it("GET /api/feature-flags reports risk features off by default", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/feature-flags" });
    expect(res.json()).toMatchObject({
      liveTrading: false,
      conditionalLiveExecution: false,
      relayer: false,
    });
    await app.close();
  });
});

describe("events routes", () => {
  it("GET /api/events returns empty list from mock client", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ events: [], count: 0 });
    await app.close();
  });

  it("GET /api/events/:id returns 404 when upstream returns 404", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/events/unknown-id" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("markets routes", () => {
  it("GET /api/markets/:id returns 404 when upstream returns 404", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/markets/unknown-id" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("auth routes", () => {
  it("GET /api/auth/challenge returns 400 without address param", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/auth/challenge" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/auth/challenge returns 400 with invalid address", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/challenge?address=notanaddress",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/auth/challenge returns typedData for a valid address", async () => {
    const challenges: ChallengeStore = {
      ...mockChallenges,
      create: async (o) =>
        ({
          id: "chal-id",
          nonce: o.nonce,
          walletAddress: o.walletAddress,
          chainId: o.chainId,
          expiresAt: o.expiresAt,
          usedAt: null,
          createdAt: new Date(o.issuedAt),
        }) satisfies AuthChallengeRow,
    };
    const app = buildApp({
      config,
      logger,
      db: { ping: async () => true },
      auditStore: mockAuditStore,
      gammaClient: mockGammaClient,
      clobClient: mockClobClient,
      dataClient: mockDataClient,
      marketSnapshots: mockMarketSnapshots,
      challenges,
      users: mockUsers,
      sessions: mockSessions,
      allowlist: mockAllowlist,
      clobCredentials: mockClobCredentials,
      orderIntents: mockOrderIntents,
      runtimeFlags: mockRuntimeFlags,
      ruleStore: mockRuleStore,
      triggerStore: mockTriggerStore,
      tradingClobClient: mockTradingClobClient,
      tradingSigner: mockTradingSigner,
      privyWallets: mockPrivyWallets,
      delegations: mockDelegations,
      geoblockClient: mockGeoblockClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/challenge?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("nonce");
    expect(body).toHaveProperty("typedData");
    await app.close();
  });

  it("POST /api/auth/verify returns 401 with invalid nonce", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        nonce: "0xdeadbeef",
        signature: "0xsig",
        issuedAt: new Date().toISOString(),
      }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/auth/me returns 401 without session cookie", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/auth/me returns user when valid session exists", async () => {
    const walletAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const sessions: SessionStore = {
      ...mockSessions,
      findByTokenHash: async () => makeSessionRow(walletAddress),
    };
    const app = buildApp({
      config,
      logger,
      db: { ping: async () => true },
      auditStore: mockAuditStore,
      gammaClient: mockGammaClient,
      clobClient: mockClobClient,
      dataClient: mockDataClient,
      marketSnapshots: mockMarketSnapshots,
      challenges: mockChallenges,
      users: mockUsers,
      sessions,
      allowlist: mockAllowlist,
      clobCredentials: mockClobCredentials,
      orderIntents: mockOrderIntents,
      runtimeFlags: mockRuntimeFlags,
      ruleStore: mockRuleStore,
      triggerStore: mockTriggerStore,
      tradingClobClient: mockTradingClobClient,
      tradingSigner: mockTradingSigner,
      privyWallets: mockPrivyWallets,
      delegations: mockDelegations,
      geoblockClient: mockGeoblockClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "mx2_session=sometoken" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { address: string; depositWallet: string | null };
    expect(body).toMatchObject({ address: walletAddress });
    // Deposit wallet is derived deterministically from the EOA (Gnosis Safe).
    expect(body.depositWallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.depositWallet?.toLowerCase()).not.toBe(walletAddress.toLowerCase());
    await app.close();
  });
});

describe("profile routes", () => {
  it("GET /api/profile/positions returns 401 without session", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/profile/positions" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/profile/pnl returns methodology and limitations when authenticated", async () => {
    const walletAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const sessions: SessionStore = {
      ...mockSessions,
      findByTokenHash: async () => makeSessionRow(walletAddress),
    };
    const app = buildApp({
      config,
      logger,
      db: { ping: async () => true },
      auditStore: mockAuditStore,
      gammaClient: mockGammaClient,
      clobClient: mockClobClient,
      dataClient: mockDataClient,
      marketSnapshots: mockMarketSnapshots,
      challenges: mockChallenges,
      users: mockUsers,
      sessions,
      allowlist: mockAllowlist,
      clobCredentials: mockClobCredentials,
      orderIntents: mockOrderIntents,
      runtimeFlags: mockRuntimeFlags,
      ruleStore: mockRuleStore,
      triggerStore: mockTriggerStore,
      tradingClobClient: mockTradingClobClient,
      tradingSigner: mockTradingSigner,
      privyWallets: mockPrivyWallets,
      delegations: mockDelegations,
      geoblockClient: mockGeoblockClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/profile/pnl",
      headers: { cookie: "mx2_session=sometoken" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("methodology");
    expect(body).toHaveProperty("limitations");
    expect(body).toHaveProperty("summary");
    await app.close();
  });

  it("GET /api/profile/overview returns aggregated portfolio when authenticated", async () => {
    const walletAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const sessions: SessionStore = {
      ...mockSessions,
      findByTokenHash: async () => makeSessionRow(walletAddress),
    };
    const app = buildApp({
      config,
      logger,
      db: { ping: async () => true },
      auditStore: mockAuditStore,
      gammaClient: mockGammaClient,
      clobClient: mockClobClient,
      dataClient: mockDataClient,
      marketSnapshots: mockMarketSnapshots,
      challenges: mockChallenges,
      users: mockUsers,
      sessions,
      allowlist: mockAllowlist,
      clobCredentials: mockClobCredentials,
      orderIntents: mockOrderIntents,
      runtimeFlags: mockRuntimeFlags,
      ruleStore: mockRuleStore,
      triggerStore: mockTriggerStore,
      tradingClobClient: mockTradingClobClient,
      tradingSigner: mockTradingSigner,
      privyWallets: mockPrivyWallets,
      delegations: mockDelegations,
      geoblockClient: mockGeoblockClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/profile/overview",
      headers: { cookie: "mx2_session=sometoken" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("positions");
    expect(body).toHaveProperty("counts");
    await app.close();
  });

  it("GET /api/profile/open-orders returns setupRequired when no creds", async () => {
    const walletAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    const sessions: SessionStore = {
      ...mockSessions,
      findByTokenHash: async () => makeSessionRow(walletAddress),
    };
    const app = buildApp({
      config,
      logger,
      db: { ping: async () => true },
      auditStore: mockAuditStore,
      gammaClient: mockGammaClient,
      clobClient: mockClobClient,
      dataClient: mockDataClient,
      marketSnapshots: mockMarketSnapshots,
      challenges: mockChallenges,
      users: mockUsers,
      sessions,
      allowlist: mockAllowlist,
      clobCredentials: mockClobCredentials,
      orderIntents: mockOrderIntents,
      runtimeFlags: mockRuntimeFlags,
      ruleStore: mockRuleStore,
      triggerStore: mockTriggerStore,
      tradingClobClient: mockTradingClobClient,
      tradingSigner: mockTradingSigner,
      privyWallets: mockPrivyWallets,
      delegations: mockDelegations,
      geoblockClient: mockGeoblockClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/profile/open-orders",
      headers: { cookie: "mx2_session=sometoken" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { setupRequired: boolean; openOrders: unknown[] };
    expect(body.setupRequired).toBe(true);
    expect(body.openOrders).toEqual([]);
    await app.close();
  });
});
