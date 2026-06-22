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
  OrderIntentRow,
  SessionRow,
  UserClobCredentialRow,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
  PolymarketError,
} from "@mx2/polymarket-client";
import { buildApp, type DbProbe } from "../app.js";
import { encryptCredentials } from "../auth/crypto.js";

const ENCRYPTION_KEY = "a".repeat(64); // valid 64-char hex for tests

const config = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
  TRADING_ADMIN_SECRET: "test-admin-secret-123",
});

const configTradingEnabled = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
  TRADING_ADMIN_SECRET: "test-admin-secret-123",
  FEATURE_LIVE_TRADING: "true",
});

const logger = createLogger({ name: "trade-test", level: "silent" });

const upstreamErr: PolymarketError = {
  code: "UPSTREAM_ERROR",
  message: "upstream error",
  statusCode: 502,
};

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

// ── Mock stores ───────────────────────────────────────────────────────────────

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

const mockDb: DbProbe = { ping: async () => true };

const mockGammaClient: GammaClient = {
  listEvents: async () => ok([]),
  getEvent: async () => err(upstreamErr),
  listMarkets: async () => ok([]),
  getMarket: async () => err(upstreamErr),
  getPricesHistory: async () => ok([]),
};

const mockClobClient: ClobClient = {
  getOrderbook: async () => err(upstreamErr),
  getTrades: async () => ok([]),
  getPrices: async () => ok([]),
  getLastTradePrice: async () => err(upstreamErr),
};

const mockDataClient: DataClient = {
  getPositions: async () => ok([]),
  getActivity: async () => ok([]),
};

const mockMarketSnapshots: MarketSnapshotStore = {
  upsert: async () => {
    throw new Error("not implemented");
  },
  findByTokenId: async () => null,
  markStale: async () => {},
};

const makeSessRow = (): SessionRow => ({
  id: "sess-id",
  userWallet: WALLET,
  tokenHash: "hash",
  expiresAt: new Date(Date.now() + 1_000_000),
  createdAt: new Date(),
  revokedAt: null,
});

const mockChallenges: ChallengeStore = {
  create: async () => {
    throw new Error("not implemented");
  },
  findByNonce: async () => null,
  markUsed: async () => {},
};

const mockUsers: UserStore = {
  upsert: async (w) => ({ walletAddress: w, createdAt: new Date(), lastSeenAt: new Date() }),
  findByWallet: async () => null,
};

const mockSessions: SessionStore = {
  create: async (_o) => makeSessRow(),
  findByTokenHash: async () => null,
  revoke: async () => {},
};

const mockSessionsAuthed: SessionStore = {
  ...mockSessions,
  findByTokenHash: async () => makeSessRow(),
};

const mockAllowlist: AllowlistStore = {
  isAllowed: async () => false,
  findEntry: async () => null,
  add: async () => {
    throw new Error("not implemented");
  },
  remove: async () => {},
};

const mockClobCredentials: ClobCredentialStore = {
  upsert: async () => {
    throw new Error("not implemented");
  },
  find: async () => null,
  delete: async () => {},
};

const mockOrderIntents: OrderIntentStore = {
  create: async () => {
    throw new Error("not implemented");
  },
  findByIdempotencyKey: async () => null,
  findById: async () => null,
  listByWallet: async () => [],
  updateStatus: async () => {},
};

const mockRuntimeFlags: RuntimeFlagStore = {
  get: async () => null,
  set: async (key, value, updatedBy) => ({ key, value, updatedBy, updatedAt: new Date() }),
};

const mockTradingClobClient: AuthenticatedClobClient = {
  deriveApiKey: async () => err(upstreamErr),
  getBalanceAllowance: async () => err(upstreamErr),
  submitOrder: async () => err(upstreamErr),
  cancelOrder: async () => err(upstreamErr),
  getOpenOrders: async () => ok([]),
};

const mockGeoblockClient: GeoblockClient = {
  check: async (ip) => ok({ status: "allowed", country: "DE", region: null, ip }),
};

const makeFakeCredsRow = (): UserClobCredentialRow => {
  const encrypted = encryptCredentials(
    {
      apiKey: "test-api-key",
      secret: Buffer.from("test-secret").toString("base64"),
      passphrase: "test-pass",
    },
    ENCRYPTION_KEY,
  );
  return {
    walletAddress: WALLET,
    encryptedCreds: encrypted,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
};

const buildTestApp = (
  overrides: {
    cfg?: ReturnType<typeof loadConfig>;
    sessions?: SessionStore;
    clobCredentials?: ClobCredentialStore;
    orderIntents?: OrderIntentStore;
    runtimeFlags?: RuntimeFlagStore;
    tradingClobClient?: AuthenticatedClobClient;
    geoblockClient?: GeoblockClient;
  } = {},
) =>
  buildApp({
    config: overrides.cfg ?? config,
    logger,
    db: mockDb,
    auditStore: mockAuditStore,
    gammaClient: mockGammaClient,
    clobClient: mockClobClient,
    dataClient: mockDataClient,
    marketSnapshots: mockMarketSnapshots,
    challenges: mockChallenges,
    users: mockUsers,
    sessions: overrides.sessions ?? mockSessions,
    allowlist: mockAllowlist,
    clobCredentials: overrides.clobCredentials ?? mockClobCredentials,
    orderIntents: overrides.orderIntents ?? mockOrderIntents,
    runtimeFlags: overrides.runtimeFlags ?? mockRuntimeFlags,
    tradingClobClient: overrides.tradingClobClient ?? mockTradingClobClient,
    geoblockClient: overrides.geoblockClient ?? mockGeoblockClient,
  });

// ── GET /api/trade/status ──────────────────────────────────────────────────────

describe("GET /api/trade/status", () => {
  it("returns tradingEnabled=false when feature flag is off", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/trade/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.tradingEnabled).toBe(false);
    expect(body.featureFlag).toBe(false);
    await app.close();
  });

  it("returns tradingEnabled=true when flag is on and not paused", async () => {
    const app = buildTestApp({ cfg: configTradingEnabled });
    const res = await app.inject({ method: "GET", url: "/api/trade/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.tradingEnabled).toBe(true);
    await app.close();
  });

  it("returns tradingEnabled=false when runtime kill switch is active", async () => {
    const pausedFlags: RuntimeFlagStore = {
      ...mockRuntimeFlags,
      get: async () => ({
        key: "trading_paused",
        value: "true",
        updatedBy: "admin",
        updatedAt: new Date(),
      }),
    };
    const app = buildTestApp({ cfg: configTradingEnabled, runtimeFlags: pausedFlags });
    const res = await app.inject({ method: "GET", url: "/api/trade/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.tradingEnabled).toBe(false);
    expect(body.runtimePaused).toBe(true);
    await app.close();
  });

  it("includes geoblock result for allowed IP", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/trade/status" });
    const body = res.json() as Record<string, unknown>;
    expect(body.geoblock).toMatchObject({ status: "allowed" });
    await app.close();
  });
});

// ── POST /api/trade/credentials/setup ─────────────────────────────────────────

describe("POST /api/trade/credentials/setup", () => {
  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ l1Signature: "0xsig", timestamp: "123", nonce: "abc" }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 when required fields are missing", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ l1Signature: "0xsig" }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 502 when CLOB key derivation fails", async () => {
    const failingClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      deriveApiKey: async () => err(upstreamErr),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, tradingClobClient: failingClient });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ l1Signature: "0xsig", timestamp: "123", nonce: "abc" }),
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("encrypts and stores CLOB credentials on success", async () => {
    let stored: unknown = null;
    const captureCreds: ClobCredentialStore = {
      ...mockClobCredentials,
      upsert: async (wallet, encrypted) => {
        stored = encrypted;
        return makeFakeCredsRow();
      },
    };
    const successClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      deriveApiKey: async () => ok({ apiKey: "ak-123", secret: "c2VjcmV0", passphrase: "pass" }),
    };
    const app = buildTestApp({
      sessions: mockSessionsAuthed,
      tradingClobClient: successClient,
      clobCredentials: captureCreds,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ l1Signature: "0xsig", timestamp: "123", nonce: "abc" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.apiKey).toBe("ak-123");
    expect(stored).not.toBeNull();
    expect((stored as Record<string, unknown>).ciphertext).toBeTruthy();
    await app.close();
  });
});

// ── GET /api/trade/account ─────────────────────────────────────────────────────

describe("GET /api/trade/account", () => {
  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/trade/account" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when live trading flag is off", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "GET",
      url: "/api/trade/account",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("TRADING_DISABLED");
    await app.close();
  });

  it("returns 400 when CLOB credentials not set up", async () => {
    const app = buildTestApp({ cfg: configTradingEnabled, sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "GET",
      url: "/api/trade/account",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("CLOB_CREDENTIALS_NOT_SET");
    await app.close();
  });

  it("returns account data when credentials exist", async () => {
    const credsStore: ClobCredentialStore = {
      ...mockClobCredentials,
      find: async () => makeFakeCredsRow(),
    };
    const balClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      getBalanceAllowance: async () => ok({ balance: "500.0", allowance: "1000.0" }),
      getOpenOrders: async () => ok([]),
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      clobCredentials: credsStore,
      tradingClobClient: balClient,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/trade/account",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.balance).toBe("500.0");
    expect(body.openOrders).toEqual([]);
    await app.close();
  });
});

// ── POST /api/trade/orders/preview ────────────────────────────────────────────

describe("POST /api/trade/orders/preview", () => {
  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 when required fields missing", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ conditionId: "0xcond", tokenId: "0xtok" }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 for invalid price", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        conditionId: "0xcond",
        tokenId: "0xtok",
        side: "BUY",
        price: "1.5",
        size: "100",
        funder: "0xfunder",
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("INVALID_PRICE");
    await app.close();
  });

  it("returns order preview with maxSpend and warning when trading is disabled", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        conditionId: "0xcond",
        tokenId: "0xtok",
        side: "BUY",
        price: "0.45",
        size: "100",
        funder: "0xfunder",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.maxSpend).toBe("45.000000");
    expect(body.signatureType).toBe(3);
    expect(typeof body.warning).toBe("string");
    expect(body.warning as string).toContain("DISABLED");
    await app.close();
  });
});

// ── POST /api/trade/orders ─────────────────────────────────────────────────────

describe("POST /api/trade/orders", () => {
  const validOrderBody = {
    idempotencyKey: "test-idem-key-1",
    conditionId: "0xcondition",
    tokenId: "0xtoken",
    side: "BUY",
    price: "0.45",
    size: "100",
    orderType: "GTC",
    funder: "0xfunder",
    signature: "0xsig",
  };

  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validOrderBody),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when feature flag is off", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(validOrderBody),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("TRADING_DISABLED");
    await app.close();
  });

  it("returns existing intent for duplicate idempotency key", async () => {
    const existingIntent: OrderIntentRow = {
      id: "existing-id",
      walletAddress: WALLET,
      idempotencyKey: "test-idem-key-1",
      conditionId: "0xcondition",
      tokenId: "0xtoken",
      side: "BUY",
      price: "0.45",
      size: "100",
      orderType: "GTC",
      funder: "0xfunder",
      status: "submitted",
      clobOrderId: "clob-order-abc",
      errorMessage: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const idempotentIntents: OrderIntentStore = {
      ...mockOrderIntents,
      findByIdempotencyKey: async (key) => (key === "test-idem-key-1" ? existingIntent : null),
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      orderIntents: idempotentIntents,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(validOrderBody),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.intentId).toBe("existing-id");
    expect(body.clobOrderId).toBe("clob-order-abc");
    expect(body.idempotent).toBe(true);
    await app.close();
  });

  it("returns 503 when kill switch is active", async () => {
    const pausedFlags: RuntimeFlagStore = {
      ...mockRuntimeFlags,
      get: async () => ({
        key: "trading_paused",
        value: "true",
        updatedBy: "admin",
        updatedAt: new Date(),
      }),
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      runtimeFlags: pausedFlags,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(validOrderBody),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("TRADING_PAUSED");
    await app.close();
  });
});

// ── DELETE /api/trade/orders/:id ──────────────────────────────────────────────

describe("DELETE /api/trade/orders/:id", () => {
  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "DELETE", url: "/api/trade/orders/abc123" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when trading is disabled", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/trade/orders/abc123",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// ── GET /api/trade/orders ──────────────────────────────────────────────────────

describe("GET /api/trade/orders", () => {
  it("returns 401 without session", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/trade/orders" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns empty list when no orders exist", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "GET",
      url: "/api/trade/orders",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Array.isArray(body.orders)).toBe(true);
    expect((body.orders as unknown[]).length).toBe(0);
    await app.close();
  });
});

// ── Admin kill switch ──────────────────────────────────────────────────────────

describe("Admin kill switch", () => {
  it("GET /api/admin/trading/status returns 401 without secret", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/trading/status" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/admin/trading/status returns 401 with wrong secret", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/trading/status",
      headers: { "x-admin-secret": "wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /api/admin/trading/status returns flag state with valid secret", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/trading/status",
      headers: { "x-admin-secret": "test-admin-secret-123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.tradingPaused).toBe(false);
    await app.close();
  });

  it("POST /api/admin/trading/pause activates kill switch", async () => {
    let capturedKey = "";
    let capturedValue = "";
    const captureFlags: RuntimeFlagStore = {
      ...mockRuntimeFlags,
      set: async (key, value, by) => {
        capturedKey = key;
        capturedValue = value;
        return { key, value, updatedBy: by, updatedAt: new Date() };
      },
    };
    const app = buildTestApp({ runtimeFlags: captureFlags });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/trading/pause",
      headers: { "x-admin-secret": "test-admin-secret-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedKey).toBe("trading_paused");
    expect(capturedValue).toBe("true");
    await app.close();
  });

  it("POST /api/admin/trading/resume lifts kill switch", async () => {
    let capturedValue = "";
    const captureFlags: RuntimeFlagStore = {
      ...mockRuntimeFlags,
      set: async (key, value, by) => {
        capturedValue = value;
        return { key, value, updatedBy: by, updatedAt: new Date() };
      },
    };
    const app = buildTestApp({ runtimeFlags: captureFlags });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/trading/resume",
      headers: { "x-admin-secret": "test-admin-secret-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedValue).toBe("false");
    await app.close();
  });

  it("trading is blocked after kill switch is activated", async () => {
    const pausedFlags: RuntimeFlagStore = {
      ...mockRuntimeFlags,
      get: async () => ({
        key: "trading_paused",
        value: "true",
        updatedBy: "admin",
        updatedAt: new Date(),
      }),
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      runtimeFlags: pausedFlags,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        idempotencyKey: "key-1",
        conditionId: "0xcond",
        tokenId: "0xtok",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: "0xf",
        signature: "0xsig",
      }),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("TRADING_PAUSED");
    await app.close();
  });
});

// ── Geoblock integration ───────────────────────────────────────────────────────

describe("Geoblock enforcement on trading routes", () => {
  it("blocks order preview from blocked IP", async () => {
    const blockedGeoblock: GeoblockClient = {
      check: async (ip) => ok({ status: "blocked", country: "RU", region: null, ip }),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, geoblockClient: blockedGeoblock });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        conditionId: "0x",
        tokenId: "0x",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: "0xf",
      }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("GEO_BLOCKED");
    await app.close();
  });

  it("blocks close_only region from placing new orders (preview endpoint)", async () => {
    const closeOnlyGeoblock: GeoblockClient = {
      check: async (ip) => ok({ status: "close_only", country: "SG", region: null, ip }),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, geoblockClient: closeOnlyGeoblock });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        conditionId: "0x",
        tokenId: "0x",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: "0xf",
      }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("GEO_CLOSE_ONLY");
    await app.close();
  });

  it("blocks trading when geoblock check fails (fail-closed)", async () => {
    const failingGeoblock: GeoblockClient = {
      check: async () => err({ code: "NETWORK_ERROR", message: "timeout" }),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, geoblockClient: failingGeoblock });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders/preview",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({
        conditionId: "0x",
        tokenId: "0x",
        side: "BUY",
        price: "0.5",
        size: "10",
        funder: "0xf",
      }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("trade/status does NOT geoblock (public diagnostic endpoint)", async () => {
    const blockedGeoblock: GeoblockClient = {
      check: async (ip) => ok({ status: "blocked", country: "RU", region: null, ip }),
    };
    const app = buildTestApp({ geoblockClient: blockedGeoblock });
    const res = await app.inject({ method: "GET", url: "/api/trade/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect((body.geoblock as Record<string, unknown>).status).toBe("blocked");
    await app.close();
  });
});
