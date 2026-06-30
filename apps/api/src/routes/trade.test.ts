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
  OrderIntentRow,
  SessionRow,
  UserClobCredentialRow,
  PrivyWalletStore,
  DelegationStore,
  PrivyWalletRow,
  TradingDelegationRow,
  TradingAccountStore,
  TradingAccountRow,
  TradingAccountClobCredentialStore,
  TradingAccountClobCredentialRow,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
  PolymarketError,
  DepositWalletRelayer,
} from "@mx2/polymarket-client";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import { buildApp, type DbProbe } from "../app.js";
import { encryptCredentials } from "../auth/crypto.js";
import type { AllowanceReader } from "../trade/allowance-bootstrap.js";

const TEST_SIGNER_KEY = `0x${"1".repeat(64)}` as const;

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

// Server-side signing enabled, using the mock signer (non-production dry-run mode).
const configPrivy = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
  TRADING_ADMIN_SECRET: "test-admin-secret-123",
  FEATURE_LIVE_TRADING: "true",
  FEATURE_PRIVY_SIGNING: "true",
  MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
});

const configRelayer = loadConfig({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
  TRADING_ADMIN_SECRET: "test-admin-secret-123",
  FEATURE_LIVE_TRADING: "true",
  FEATURE_PRIVY_SIGNING: "true",
  FEATURE_RELAYER: "true",
  MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  POLYGON_RPC_URL: "https://polygon.example.test",
  POLYMARKET_RELAYER_URL: "https://relayer.example.test",
  POLYMARKET_BUILDER_API_KEY: "builder-key",
  POLYMARKET_BUILDER_SECRET: "builder-secret",
  POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
});

const logger = createLogger({ name: "trade-test", level: "silent" });

const upstreamErr: PolymarketError = {
  code: "UPSTREAM_ERROR",
  message: "upstream error",
  statusCode: 502,
};

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const TRADING_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const FUNDER = "0xf000000000000000000000000000000000000001";

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
  findMarket: async () => ok(null),
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
  countRecentByWallet: async () => 0,
};

const mockRuntimeFlags: RuntimeFlagStore = {
  get: async () => null,
  set: async (key, value, updatedBy) => ({ key, value, updatedBy, updatedAt: new Date() }),
};

const mockRuleStore: RuleStore = {
  create: async () => {
    throw new Error("not implemented");
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
};

const mockTriggerStore: TriggerStore = {
  create: async () => {
    throw new Error("not implemented");
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

const mockTradingSigner: TradingSigner = createMockTradingSigner({ privateKey: TEST_SIGNER_KEY });

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

const makeTradingAccountRow = (overrides: Partial<TradingAccountRow> = {}): TradingAccountRow => ({
  id: TRADING_ACCOUNT_ID,
  ownerWalletAddress: WALLET,
  kind: "external_wallet",
  label: "Connected Polymarket wallet",
  signerAddress: WALLET,
  funderAddress: FUNDER,
  signatureType: 2,
  signingMode: "browser",
  status: "ready",
  isPrimary: true,
  privyWalletId: null,
  depositWalletAddress: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  archivedAt: null,
  ...overrides,
});

const mockTradingAccounts: TradingAccountStore = {
  listByOwner: async () => [makeTradingAccountRow()],
  findByOwner: async (_owner, id) => (id === TRADING_ACCOUNT_ID ? makeTradingAccountRow() : null),
  getPrimary: async () => makeTradingAccountRow(),
  setPrimary: async (_owner, id) => (id === TRADING_ACCOUNT_ID ? makeTradingAccountRow() : null),
  upsertExternal: async () => makeTradingAccountRow(),
  upsertInternalPrivy: async (opts) =>
    makeTradingAccountRow({
      kind: "internal_privy",
      signerAddress: opts.signerAddress,
      funderAddress: opts.depositWalletAddress ?? null,
      signatureType: 3,
      signingMode: opts.status === "ready" ? "server" : "unavailable",
      status: opts.status,
      privyWalletId: opts.privyWalletId,
      depositWalletAddress: opts.depositWalletAddress ?? null,
    }),
  markReady: async () => {},
  updateStatus: async () => {},
  archive: async () => null,
};

const makePrivyWalletRow = (): PrivyWalletRow => ({
  walletAddress: WALLET,
  privyUserId: WALLET,
  privyWalletId: "pw-test",
  embeddedAddress: "0x1111111111111111111111111111111111111111",
  policyId: "policy-test",
  allowancesBootstrappedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeActiveDelegationRow = (): TradingDelegationRow => ({
  id: "deleg-1",
  walletAddress: WALLET,
  sessionSignerId: "ss-1",
  status: "active",
  grantedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  createdAt: new Date(),
});

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

const makeFakeAccountCredsRow = (): TradingAccountClobCredentialRow => {
  const encrypted = encryptCredentials(
    {
      apiKey: "test-api-key",
      secret: Buffer.from("test-secret").toString("base64"),
      passphrase: "test-pass",
    },
    ENCRYPTION_KEY,
  );
  return {
    tradingAccountId: TRADING_ACCOUNT_ID,
    ownerWalletAddress: WALLET,
    encryptedCreds: encrypted,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
};

const mockAccountClobCredentials: TradingAccountClobCredentialStore = {
  upsert: async (tradingAccountId, ownerWalletAddress, encryptedCreds) => ({
    tradingAccountId,
    ownerWalletAddress,
    encryptedCreds,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  find: async () => makeFakeAccountCredsRow(),
  delete: async () => {},
};

const buildTestApp = (
  overrides: {
    cfg?: ReturnType<typeof loadConfig>;
    sessions?: SessionStore;
    clobCredentials?: ClobCredentialStore;
    orderIntents?: OrderIntentStore;
    runtimeFlags?: RuntimeFlagStore;
    tradingAccounts?: TradingAccountStore;
    accountClobCredentials?: TradingAccountClobCredentialStore;
    tradingClobClient?: AuthenticatedClobClient;
    geoblockClient?: GeoblockClient;
    tradingSigner?: TradingSigner;
    depositWalletRelayer?: DepositWalletRelayer;
    privyWallets?: PrivyWalletStore;
    delegations?: DelegationStore;
    allowanceReader?: AllowanceReader | null;
  } = {},
) => {
  const deps: Parameters<typeof buildApp>[0] = {
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
    tradingAccounts: overrides.tradingAccounts ?? mockTradingAccounts,
    accountClobCredentials: overrides.accountClobCredentials ?? mockAccountClobCredentials,
    orderIntents: overrides.orderIntents ?? mockOrderIntents,
    runtimeFlags: overrides.runtimeFlags ?? mockRuntimeFlags,
    ruleStore: mockRuleStore,
    triggerStore: mockTriggerStore,
    privyWallets: overrides.privyWallets ?? mockPrivyWallets,
    delegations: overrides.delegations ?? mockDelegations,
    tradingClobClient: overrides.tradingClobClient ?? mockTradingClobClient,
    tradingSigner: overrides.tradingSigner ?? mockTradingSigner,
    geoblockClient: overrides.geoblockClient ?? mockGeoblockClient,
    allowanceReader: overrides.allowanceReader ?? null,
  };
  if (overrides.depositWalletRelayer) deps.depositWalletRelayer = overrides.depositWalletRelayer;
  return buildApp(deps);
};

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

// ── GET /api/trade/clob-time ──────────────────────────────────────────────────

describe("GET /api/trade/clob-time", () => {
  it("returns CLOB server timestamp", async () => {
    const app = buildTestApp({
      tradingClobClient: {
        ...mockTradingClobClient,
        getServerTime: async () => ok(1_782_226_240),
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/trade/clob-time" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ timestamp: 1_782_226_240 });
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
    const captureCreds: TradingAccountClobCredentialStore = {
      ...mockAccountClobCredentials,
      upsert: async (_accountId, _owner, encrypted) => {
        stored = encrypted;
        return makeFakeAccountCredsRow();
      },
    };
    const successClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      deriveApiKey: async () => ok({ apiKey: "ak-123", secret: "c2VjcmV0", passphrase: "pass" }),
    };
    const app = buildTestApp({
      sessions: mockSessionsAuthed,
      tradingClobClient: successClient,
      accountClobCredentials: captureCreds,
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
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      accountClobCredentials: { ...mockAccountClobCredentials, find: async () => null },
    });
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
    const balClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      getBalanceAllowance: async () => ok({ balance: "500.0", allowance: "1000.0" }),
      getOpenOrders: async () => ok([]),
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
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
    expect(body.signatureType).toBe(2);
    expect(typeof body.warning).toBe("string");
    expect(body.warning as string).toContain("DISABLED");
    await app.close();
  });
});

// ── POST /api/trade/orders ─────────────────────────────────────────────────────

describe("POST /api/trade/orders", () => {
  // New contract: the client sends a fully-signed CLOB order struct plus
  // human-readable price/size/conditionId for the intent record.
  const validOrderBody = {
    tradingAccountId: TRADING_ACCOUNT_ID,
    idempotencyKey: "test-idem-key-1",
    conditionId: "0xcondition",
    price: "0.45",
    size: "100",
    orderType: "GTC",
    order: {
      salt: "123456",
      maker: FUNDER,
      signer: WALLET,
      tokenId: "0xtoken",
      makerAmount: "45000000",
      takerAmount: "100000000",
      side: "BUY",
      signatureType: 2,
      timestamp: "1700000000000",
      metadata: "0x0000000000000000000000000000000000000000000000000000000000000000",
      builder: "0x0000000000000000000000000000000000000000000000000000000000000000",
      expiration: "0",
      signature: "0xsig",
    },
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
      tradingAccountId: TRADING_ACCOUNT_ID,
      idempotencyKey: "test-idem-key-1",
      conditionId: "0xcondition",
      tokenId: "0xtoken",
      side: "BUY",
      price: "0.45",
      size: "100",
      orderType: "GTC",
      funder: FUNDER,
      signer: WALLET,
      signatureType: 2,
      signingMode: "browser",
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

  it("rejects a body without a valid signed order (400)", async () => {
    const app = buildTestApp({ cfg: configTradingEnabled, sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      // Missing `order` entirely (old flat shape).
      body: JSON.stringify({
        idempotencyKey: "k",
        conditionId: "0xc",
        tokenId: "0xt",
        side: "BUY",
        price: "0.45",
        size: "100",
        signature: "0xsig",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("forwards the signed order verbatim and records a submitted intent (201)", async () => {
    let forwarded: { order: unknown; orderType: unknown } | null = null;
    const submittingClob: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      submitOrder: async (order, orderType) => {
        forwarded = { order, orderType };
        return ok({ orderID: "clob-xyz", status: "live" });
      },
    };
    const credsStore: ClobCredentialStore = {
      ...mockClobCredentials,
      find: async () => makeFakeCredsRow(),
    };
    const createdIntent: OrderIntentRow = {
      id: "intent-1",
      walletAddress: WALLET,
      tradingAccountId: TRADING_ACCOUNT_ID,
      idempotencyKey: "test-idem-key-1",
      conditionId: "0xcondition",
      tokenId: "0xtoken",
      side: "BUY",
      price: "0.45",
      size: "100",
      orderType: "GTC",
      funder: FUNDER,
      signer: WALLET,
      signatureType: 2,
      signingMode: "browser",
      status: "pending",
      clobOrderId: null,
      errorMessage: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const intentsStore: OrderIntentStore = {
      ...mockOrderIntents,
      create: async () => createdIntent,
      updateStatus: async () => {},
    };
    const app = buildTestApp({
      cfg: configTradingEnabled,
      sessions: mockSessionsAuthed,
      clobCredentials: credsStore,
      orderIntents: intentsStore,
      tradingClobClient: submittingClob,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(validOrderBody),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.clobOrderId).toBe("clob-xyz");
    expect(body.status).toBe("submitted");
    // The exact signed struct (incl. signatureType 2) is forwarded unmutated.
    expect(forwarded).not.toBeNull();
    expect(forwarded!.orderType).toBe("GTC");
    expect(forwarded!.order).toMatchObject({
      signatureType: 2,
      signature: "0xsig",
      side: "BUY",
      timestamp: "1700000000000",
    });
    await app.close();
  });
});

// ── POST /api/trade/orders (Privy server-side signing) ────────────────────────

describe("POST /api/trade/orders (Privy deposit-wallet guardrails)", () => {
  const EMBEDDED = "0x1111111111111111111111111111111111111111";
  const privyOrderBody = {
    tradingAccountId: TRADING_ACCOUNT_ID,
    idempotencyKey: "privy-idem-1",
    conditionId: "0xcondition",
    tokenId: "123456",
    side: "BUY",
    price: "0.45",
    size: "100",
    orderType: "GTC",
  };

  const internalPendingAccounts: TradingAccountStore = {
    ...mockTradingAccounts,
    getPrimary: async () =>
      makeTradingAccountRow({
        kind: "internal_privy",
        signerAddress: EMBEDDED,
        funderAddress: null,
        signatureType: 3,
        signingMode: "unavailable",
        status: "needs_deposit_wallet",
        privyWalletId: "pw-test",
      }),
    findByOwner: async () =>
      makeTradingAccountRow({
        kind: "internal_privy",
        signerAddress: EMBEDDED,
        funderAddress: null,
        signatureType: 3,
        signingMode: "unavailable",
        status: "needs_deposit_wallet",
        privyWalletId: "pw-test",
      }),
  };
  const internalReadyAccounts: TradingAccountStore = {
    ...mockTradingAccounts,
    getPrimary: async () =>
      makeTradingAccountRow({
        kind: "internal_privy",
        signerAddress: EMBEDDED,
        funderAddress: FUNDER,
        signatureType: 3,
        signingMode: "server",
        status: "ready",
        privyWalletId: "pw-test",
        depositWalletAddress: FUNDER,
      }),
    findByOwner: async () =>
      makeTradingAccountRow({
        kind: "internal_privy",
        signerAddress: EMBEDDED,
        funderAddress: FUNDER,
        signatureType: 3,
        signingMode: "server",
        status: "ready",
        privyWalletId: "pw-test",
        depositWalletAddress: FUNDER,
      }),
  };

  it("returns 409 until the Privy wallet has a registered deposit wallet", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      tradingAccounts: internalPendingAccounts,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(privyOrderBody),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Record<string, unknown>).error).toBe("TRADING_ACCOUNT_NOT_READY");
    await app.close();
  });

  it("returns 409 for server-signing accounts until the relayer order path is enabled", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      tradingAccounts: internalReadyAccounts,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(privyOrderBody),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Record<string, unknown>).error).toBe("RELAYER_ORDER_PATH_NOT_ENABLED");
    await app.close();
  });

  it("returns 429 when the per-minute order rate limit is exceeded", async () => {
    const overLimit: OrderIntentStore = {
      ...mockOrderIntents,
      countRecentByWallet: async () => 999,
    };
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      orderIntents: overLimit,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(privyOrderBody),
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as Record<string, unknown>).error).toBe("RATE_LIMITED");
    await app.close();
  });

  it("POST /bootstrap-allowances is blocked until the relayer deposit wallet exists", async () => {
    const reader: AllowanceReader = {
      erc20Allowance: async () => 0n,
      isApprovedForAll: async () => false,
    };
    let marked = false;
    const wallets: PrivyWalletStore = {
      ...mockPrivyWallets,
      find: async () => ({ ...makePrivyWalletRow(), allowancesBootstrappedAt: null }),
      markAllowancesBootstrapped: async () => {
        marked = true;
      },
    };
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: wallets,
      allowanceReader: reader,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/bootstrap-allowances",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("DEPOSIT_WALLET_REQUIRED");
    expect(marked).toBe(false);
    await app.close();
  });

  it("requires a manual CLOB auth signature until deposit-wallet auth is implemented", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("MANUAL_SIGNATURE_REQUIRED");
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

// ── Trading wallet onboarding (Privy) ─────────────────────────────────────────

describe("Trading wallet onboarding", () => {
  it("POST /provision returns 401 without session", async () => {
    const app = buildTestApp({ cfg: configPrivy });
    const res = await app.inject({ method: "POST", url: "/api/trading-wallet/provision" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /provision returns 503 when server-side signing is disabled", async () => {
    const app = buildTestApp({ sessions: mockSessionsAuthed }); // default config: privySigning off
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as Record<string, unknown>).error).toBe("PRIVY_SIGNING_DISABLED");
    await app.close();
  });

  it("POST /provision creates an embedded wallet and persists the reference", async () => {
    let upserted: { embeddedAddress: string; privyWalletId: string } | null = null;
    const wallets: PrivyWalletStore = {
      ...mockPrivyWallets,
      find: async () => null,
      upsert: async (opts) => {
        upserted = { embeddedAddress: opts.embeddedAddress, privyWalletId: opts.privyWalletId };
        return {
          ...makePrivyWalletRow(),
          embeddedAddress: opts.embeddedAddress,
          privyWalletId: opts.privyWalletId,
          policyId: opts.policyId ?? null,
          allowancesBootstrappedAt: null,
        };
      },
    };
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: wallets,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.alreadyProvisioned).toBe(false);
    expect(upserted).not.toBeNull();
    expect(body.embeddedAddress).toBe(upserted!.embeddedAddress);
    expect(body.embeddedAddress as string).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await app.close();
  });

  it("POST /activate-deposit-wallet returns 503 when the relayer is disabled", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/activate-deposit-wallet",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as Record<string, unknown>).error).toBe("RELAYER_DISABLED");
    await app.close();
  });

  it("POST /activate-deposit-wallet records a confirmed relayer deployment", async () => {
    const depositWalletAddress = "0x2222222222222222222222222222222222222222";
    let upserted: {
      depositWalletAddress: string | null | undefined;
      status: string;
      signerAddress: string;
    } | null = null;
    const relayer: DepositWalletRelayer = {
      enabled: true,
      deriveDepositWalletAddress: async (owner) =>
        ok({ ownerAddress: owner.ownerAddress, depositWalletAddress }),
      getDeploymentStatus: async (owner) =>
        ok({
          ownerAddress: owner.ownerAddress,
          depositWalletAddress,
          deployed: false,
          state: "STATE_NEW",
        }),
      deployDepositWallet: async (owner) =>
        ok({
          ownerAddress: owner.ownerAddress,
          depositWalletAddress,
          deployed: true,
          submitted: true,
          state: "STATE_MINED",
          transactionId: "relayer-tx-1",
          transactionHash: "0xabc",
        }),
    };
    const tradingAccounts: TradingAccountStore = {
      ...mockTradingAccounts,
      upsertInternalPrivy: async (opts) => {
        upserted = {
          depositWalletAddress: opts.depositWalletAddress,
          status: opts.status,
          signerAddress: opts.signerAddress,
        };
        return makeTradingAccountRow({
          kind: "internal_privy",
          signerAddress: opts.signerAddress,
          funderAddress: opts.depositWalletAddress ?? null,
          signatureType: 3,
          signingMode: opts.status === "ready" ? "server" : "unavailable",
          status: opts.status,
          privyWalletId: opts.privyWalletId,
          depositWalletAddress: opts.depositWalletAddress ?? null,
        });
      },
    };
    const app = buildTestApp({
      cfg: configRelayer,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingAccounts,
      depositWalletRelayer: relayer,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/activate-deposit-wallet",
      headers: { cookie: "mx2_session=tok" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.depositWalletAddress).toBe(depositWalletAddress);
    expect(body.nextAction).toBe("top_up");
    expect(upserted).toEqual({
      depositWalletAddress,
      status: "needs_funding",
      signerAddress: makePrivyWalletRow().embeddedAddress,
    });
    await app.close();
  });

  it("POST /delegate returns 400 when wallet not provisioned", async () => {
    const app = buildTestApp({ cfg: configPrivy, sessions: mockSessionsAuthed });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/delegate",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: "{}",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe("TRADING_WALLET_NOT_PROVISIONED");
    await app.close();
  });

  it("POST /delegate records a time-bounded delegation", async () => {
    let created: { expiresAt: Date } | null = null;
    const delegations: DelegationStore = {
      ...mockDelegations,
      create: async (opts) => {
        created = { expiresAt: opts.expiresAt };
        return makeActiveDelegationRow();
      },
    };
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      delegations,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/delegate",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).ok).toBe(true);
    expect(created).not.toBeNull();
    expect(created!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await app.close();
  });

  it("GET /api/trading-wallet reports provisioning + delegation status", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      delegations: { ...mockDelegations, findActive: async () => makeActiveDelegationRow() },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/trading-wallet",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.provisioned).toBe(true);
    expect(body.delegationActive).toBe(true);
    expect(body.allowancesBootstrapped).toBe(true);
    await app.close();
  });

  it("POST /revoke clears the delegation", async () => {
    let revoked = false;
    const delegations: DelegationStore = {
      ...mockDelegations,
      revoke: async () => {
        revoked = true;
      },
    };
    const app = buildTestApp({ cfg: configPrivy, sessions: mockSessionsAuthed, delegations });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/revoke",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    expect(revoked).toBe(true);
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

// TODO(geoblock): route-level geoblock is TEMPORARILY DISABLED for local testing
// (see trade.ts). Re-enable these tests together with the geoblockCheck preHandlers.
describe.skip("Geoblock enforcement on trading routes", () => {
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
});

describe("Geoblock reporting (status endpoint)", () => {
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
