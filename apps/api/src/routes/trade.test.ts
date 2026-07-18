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
  WithdrawalStore,
  BridgeStore,
  BridgeWithdrawalRow,
} from "@mx2/db";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  AuthenticatedClobClient,
  GeoblockClient,
  PolymarketError,
  DepositWalletRelayer,
  BridgeClient,
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
  getClobMarket: async () => err(upstreamErr),
  getFeeRate: async () => err(upstreamErr),
  getRewardsMarket: async () => err(upstreamErr),
  getRewardsMarketsCurrent: async () => err(upstreamErr),
};

const mockDataClient: DataClient = {
  getPositions: async () => ok([]),
  getMarketTrades: async () => ok([]),
  getHolders: async () => ok([]),
  getClosedPositions: async () => ok([]),
  getActivity: async () => ok([]),
  getPositionValue: async () => ok(null),
  getLeaderboardEntry: async () => ok(null),
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
  sumRuleAutoNotional: async () => 0,
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
  setTags: async () => null,
  archive: async () => null,
  unarchive: async () => null,
  addExecutedNotional: async () => {},
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
    auditStore?: AuditStore;
    withdrawals?: WithdrawalStore;
    bridgeClient?: BridgeClient;
    bridgeStore?: BridgeStore;
  } = {},
) => {
  const deps: Parameters<typeof buildApp>[0] = {
    config: overrides.cfg ?? config,
    logger,
    db: mockDb,
    auditStore: overrides.auditStore ?? mockAuditStore,
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
    ...(overrides.withdrawals ? { withdrawals: overrides.withdrawals } : {}),
    ...(overrides.bridgeClient ? { bridgeClient: overrides.bridgeClient } : {}),
    ...(overrides.bridgeStore ? { bridgeStore: overrides.bridgeStore } : {}),
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

  it("never writes raw L2 credentials into audit metadata", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const captureAudit: AuditStore = {
      ...mockAuditStore,
      emit: async (e) => {
        emitted.push(e.metadata);
        return mockAuditStore.emit(e);
      },
    };
    const successClient: AuthenticatedClobClient = {
      ...mockTradingClobClient,
      deriveApiKey: async () => ok({ apiKey: "ak-123", secret: "c2VjcmV0", passphrase: "pass" }),
    };
    const app = buildTestApp({
      sessions: mockSessionsAuthed,
      tradingClobClient: successClient,
      auditStore: captureAudit,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/credentials/setup",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ l1Signature: "0xsig", timestamp: "123", nonce: "abc" }),
    });
    expect(res.statusCode).toBe(200);
    expect(emitted.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("ak-123");
    expect(serialized).not.toContain("c2VjcmV0");
    expect(serialized).not.toContain("pass");
    const setupMeta = emitted.find((m) => "apiKeyFingerprint" in m);
    expect(setupMeta).toBeTruthy();
    expect(setupMeta!.apiKeyFingerprint).toMatch(/^[0-9a-f]{12}$/);
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

  it("returns 409 for server-signing accounts when a prerequisite is missing (fail-closed)", async () => {
    // Ready account but FEATURE_PRIVY_SIGNING off → the W4 path must refuse
    // rather than sign with a disabled signer.
    const app = buildTestApp({
      cfg: configTradingEnabled,
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

  it("400s a server-signed order without tokenId/side (never guesses)", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      tradingAccounts: internalReadyAccounts,
    });
    const { tokenId: _t, side: _s, ...withoutToken } = privyOrderBody;
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify(withoutToken),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("submits a server-built POLY_1271 order (maker = signer = funder = deposit wallet)", async () => {
    const submitted: { order: Record<string, unknown>; address: string; postOnly?: boolean }[] = [];
    const intents: Record<string, unknown>[] = [];
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      tradingAccounts: internalReadyAccounts,
      orderIntents: {
        ...mockOrderIntents,
        create: async (opts) => {
          intents.push(opts as unknown as Record<string, unknown>);
          return {
            id: "intent-w4",
            ...opts,
            status: "pending",
            clobOrderId: null,
            errorMessage: null,
            metadata: opts.metadata ?? {},
            createdAt: new Date(),
            updatedAt: new Date(),
          } as never;
        },
      },
      tradingClobClient: {
        ...mockTradingClobClient,
        submitOrder: async (order, _type, _creds, address, _idem, opts) => {
          submitted.push({
            order: order as unknown as Record<string, unknown>,
            address,
            ...(opts?.postOnly !== undefined ? { postOnly: opts.postOnly } : {}),
          });
          return ok({ orderID: "clob-1271-1", status: "live" });
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
      headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
      body: JSON.stringify({ ...privyOrderBody, postOnly: true }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().clobOrderId).toBe("clob-1271-1");
    expect(submitted).toHaveLength(1);
    const order = submitted[0]!.order;
    // The V2 struct: maker = signer = funder = the DEPOSIT wallet, sigType 3,
    // ERC-7739 signature; the L2 header identity is the checksummed EOA.
    expect((order["maker"] as string).toLowerCase()).toBe(FUNDER.toLowerCase());
    expect((order["signer"] as string).toLowerCase()).toBe(FUNDER.toLowerCase());
    expect(order["signatureType"]).toBe(3);
    expect(order["tokenId"]).toBe("123456");
    expect((order["signature"] as string).length).toBeGreaterThan(132); // 7739 envelope > plain sig
    expect(submitted[0]!.address.toLowerCase()).toBe(EMBEDDED.toLowerCase());
    expect(submitted[0]!.postOnly).toBe(true);
    expect(intents[0]!["funder"]).toBe(FUNDER);
    expect(intents[0]!["signingMode"]).toBe("server");
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

  it("POST /bootstrap-allowances fails closed when the relayer is disabled", async () => {
    // Allowances execute FROM the deposit wallet via the relayer batch (W2);
    // without the relayer the route must refuse before touching anything.
    const reader: AllowanceReader = {
      erc20Allowance: async () => 0n,
      isApprovedForAll: async () => false,
      erc20Balance: async () => 0n,
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
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("RELAYER_DISABLED");
    expect(marked).toBe(false);
    await app.close();
  });

  it("still requires a manual CLOB auth signature for EXTERNAL accounts", async () => {
    // Server-side ClobAuth (W3) only covers internal Privy accounts — an
    // external wallet's key never touches the server, so no body signature
    // means 409, exactly as before.
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

  describe("server-side ClobAuth for internal accounts (W3)", () => {
    const internalPrivyAccount = () =>
      makeTradingAccountRow({
        kind: "internal_privy",
        signerAddress: "0x1111111111111111111111111111111111111111",
        privyWalletId: "pw-test",
        depositWalletAddress: "0x9999999999999999999999999999999999999999",
        signatureType: 3,
        signingMode: "server",
      });
    const internalAccounts: TradingAccountStore = {
      ...mockTradingAccounts,
      getPrimary: async () => internalPrivyAccount(),
      findByOwner: async () => internalPrivyAccount(),
    };

    it("derives L2 creds with a server-signed ClobAuth at CLOB server time", async () => {
      const derived: Record<string, unknown>[] = [];
      const upserts: string[] = [];
      const events: string[] = [];
      const app = buildTestApp({
        cfg: configPrivy,
        sessions: mockSessionsAuthed,
        tradingAccounts: internalAccounts,
        tradingClobClient: {
          ...mockTradingClobClient,
          getServerTime: async () => ok(1_782_226_240),
          deriveApiKey: async (params) => {
            derived.push(params as unknown as Record<string, unknown>);
            return ok({ apiKey: "ak-1271", secret: "c2VjcmV0", passphrase: "pass" });
          },
        },
        accountClobCredentials: {
          ...mockAccountClobCredentials,
          upsert: async (id, owner, encryptedCreds) => {
            upserts.push(id);
            return { tradingAccountId: id, ownerWalletAddress: owner, encryptedCreds } as never;
          },
        },
        auditStore: {
          ...mockAuditStore,
          emit: async (e) => {
            events.push(e.action);
            return mockAuditStore.emit(e);
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/trade/credentials/setup",
        headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().apiKey).toBe("ak-1271");
      expect(derived).toHaveLength(1);
      // Identity = the checksummed signer EOA; timestamp = CLOB server time;
      // nonce = Polymarket's default 0.
      expect(derived[0]!["address"]).toBe("0x1111111111111111111111111111111111111111");
      expect(derived[0]!["timestamp"]).toBe("1782226240");
      expect(derived[0]!["nonce"]).toBe("0");
      expect(typeof derived[0]!["l1Signature"]).toBe("string");
      expect((derived[0]!["l1Signature"] as string).length).toBe(132); // plain 65-byte sig
      expect(upserts).toEqual([TRADING_ACCOUNT_ID]);
      expect(events).toContain("trade.credentials.setup");
      await app.close();
    });

    it("502s (nothing stored) when the signer refuses", async () => {
      const upserts: string[] = [];
      const app = buildTestApp({
        cfg: configPrivy,
        sessions: mockSessionsAuthed,
        tradingAccounts: internalAccounts,
        tradingSigner: {
          ...mockTradingSigner,
          signClobAuth: async () =>
            err({ code: "POLICY_DENIED" as const, message: "policy says no" }),
        },
        accountClobCredentials: {
          ...mockAccountClobCredentials,
          upsert: async (id, owner, encryptedCreds) => {
            upserts.push(id);
            return { tradingAccountId: id, ownerWalletAddress: owner, encryptedCreds } as never;
          },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/trade/credentials/setup",
        headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("POLICY_DENIED");
      expect(upserts).toHaveLength(0);
      await app.close();
    });

    it("falls back to 409 when privy signing is disabled (fail-closed)", async () => {
      const app = buildTestApp({
        cfg: configTradingEnabled, // has master key, no FEATURE_PRIVY_SIGNING
        sessions: mockSessionsAuthed,
        tradingAccounts: internalAccounts,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/trade/credentials/setup",
        headers: { "content-type": "application/json", cookie: "mx2_session=tok" },
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("MANUAL_SIGNATURE_REQUIRED");
      await app.close();
    });
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

  // ── Self-healing after out-of-band wallet deletion (e.g. Privy dashboard) ──

  const signerWith = (over: Partial<TradingSigner>): TradingSigner => ({
    ...mockTradingSigner,
    ...over,
  });

  const captureAudit = () => {
    const events: string[] = [];
    const auditStore: AuditStore = {
      ...mockAuditStore,
      emit: async (e) => {
        events.push(e.action);
        return mockAuditStore.emit(e);
      },
    };
    return { events, auditStore };
  };

  it("POST /provision self-heals when the provider says the wallet is gone", async () => {
    let upserted: { privyWalletId: string } | null = null;
    let provisionCalls = 0;
    const archived: string[] = [];
    const ghostAccount = makeTradingAccountRow({
      id: "acct-ghost",
      kind: "internal_privy",
      privyWalletId: "pw-test",
      signerAddress: "0x1111111111111111111111111111111111111111",
      isPrimary: false,
    });
    const { events, auditStore } = captureAudit();
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      auditStore,
      privyWallets: {
        ...mockPrivyWallets,
        find: async () => makePrivyWalletRow(), // stale row → pw-test
        upsert: async (opts) => {
          upserted = { privyWalletId: opts.privyWalletId };
          return {
            ...makePrivyWalletRow(),
            privyWalletId: opts.privyWalletId,
            embeddedAddress: opts.embeddedAddress,
            allowancesBootstrappedAt: null,
          };
        },
      },
      tradingAccounts: {
        ...mockTradingAccounts,
        listByOwner: async () => [makeTradingAccountRow(), ghostAccount],
        archive: async (_owner, id) => {
          archived.push(id);
          return { ...ghostAccount, archivedAt: new Date() };
        },
      },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({ ok: true, value: "not_found" as const }),
        provisionWallet: async () => {
          provisionCalls++;
          return {
            ok: true,
            value: { walletId: "pw-new", address: "0x2222222222222222222222222222222222222222" },
          };
        },
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.alreadyProvisioned).toBe(false);
    expect(body.reissued).toBe(true);
    expect(body.walletHealth).toBe("ok");
    expect(provisionCalls).toBe(1);
    expect(upserted!.privyWalletId).toBe("pw-new");
    expect(archived).toEqual(["acct-ghost"]); // only the ghost, never the external account
    expect(events).toContain("trading_wallet.ghost_detected");
    expect(events).toContain("trading_wallet.reissued");
    await app.close();
  });

  it("POST /provision never destroys the mapping on a transient verification failure", async () => {
    let upsertCalls = 0;
    let provisionCalls = 0;
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: {
        ...mockPrivyWallets,
        find: async () => makePrivyWalletRow(),
        upsert: async () => {
          upsertCalls++;
          throw new Error("must not be called");
        },
      },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({
          ok: false,
          error: { code: "NETWORK_ERROR", message: "timeout" },
        }),
        provisionWallet: async () => {
          provisionCalls++;
          throw new Error("must not be called");
        },
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.alreadyProvisioned).toBe(true);
    expect(body.reissued).toBe(false);
    expect(body.walletHealth).toBe("unknown");
    expect(upsertCalls).toBe(0);
    expect(provisionCalls).toBe(0);
    await app.close();
  });

  it("POST /provision re-links an active wallet exactly as before", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({ ok: true, value: "active" as const }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.alreadyProvisioned).toBe(true);
    expect(body.reissued).toBe(false);
    expect(body.walletHealth).toBe("ok");
    await app.close();
  });

  it("POST /provision restores an app-archived account (Remove wallet → Create dead-end)", async () => {
    // The user soft-deleted their trading account in the app while the Privy
    // wallet stayed alive. Re-provisioning re-links into the archived row,
    // which the store restores (wasArchived) — the route must audit it.
    const { events, auditStore } = captureAudit();
    let upsertCalls = 0;
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      auditStore,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingAccounts: {
        ...mockTradingAccounts,
        // Archived row is invisible to list paths…
        listByOwner: async () => [makeTradingAccountRow()],
        // …but the signer-keyed upsert finds and restores it.
        upsertInternalPrivy: async (opts) => {
          upsertCalls++;
          return {
            ...makeTradingAccountRow({
              id: "acct-restored",
              kind: "internal_privy",
              signerAddress: opts.signerAddress,
              privyWalletId: opts.privyWalletId,
              status: opts.status,
              archivedAt: null,
            }),
            wasArchived: true,
          };
        },
      },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({ ok: true, value: "active" as const }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/provision",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.alreadyProvisioned).toBe(true);
    expect(body.reissued).toBe(false);
    expect(body.tradingAccountId).toBe("acct-restored");
    expect(upsertCalls).toBe(1);
    expect(events).toContain("trading_account.unarchived");
    await app.close();
  });

  it("POST /reissue returns 401 without session and 409 when the wallet is still active", async () => {
    const noSession = buildTestApp({ cfg: configPrivy });
    const unauth = await noSession.inject({ method: "POST", url: "/api/trading-wallet/reissue" });
    expect(unauth.statusCode).toBe(401);
    await noSession.close();

    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({ ok: true, value: "active" as const }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/reissue",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Record<string, unknown>).error).toBe("WALLET_STILL_ACTIVE");
    await app.close();
  });

  it("POST /reissue fails closed (502) when the provider is unreachable", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({
          ok: false,
          error: { code: "NETWORK_ERROR", message: "timeout" },
        }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/reissue",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as Record<string, unknown>).error).toBe("WALLET_VERIFY_FAILED");
    await app.close();
  });

  it("POST /reissue heals a dead wallet", async () => {
    let upserted: { privyWalletId: string } | null = null;
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: {
        ...mockPrivyWallets,
        find: async () => makePrivyWalletRow(),
        upsert: async (opts) => {
          upserted = { privyWalletId: opts.privyWalletId };
          return {
            ...makePrivyWalletRow(),
            privyWalletId: opts.privyWalletId,
            embeddedAddress: opts.embeddedAddress,
            allowancesBootstrappedAt: null,
          };
        },
      },
      tradingSigner: signerWith({
        getWalletStatus: async () => ({ ok: true, value: "not_found" as const }),
        provisionWallet: async () => ({
          ok: true,
          value: { walletId: "pw-new", address: "0x2222222222222222222222222222222222222222" },
        }),
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/reissue",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.reissued).toBe(true);
    expect(body.created).toBe(false);
    expect(upserted!.privyWalletId).toBe("pw-new");
    await app.close();
  });

  it("GET /api/trading-wallet?verify=1 reports walletHealth missing/ok/unknown", async () => {
    const build = (status: Awaited<ReturnType<TradingSigner["getWalletStatus"]>>) =>
      buildTestApp({
        cfg: configPrivy,
        sessions: mockSessionsAuthed,
        privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
        tradingSigner: signerWith({ getWalletStatus: async () => status }),
      });

    for (const [status, expected] of [
      [{ ok: true, value: "active" }, "ok"],
      [{ ok: true, value: "not_found" }, "missing"],
      [{ ok: false, error: { code: "NETWORK_ERROR", message: "x" } }, "unknown"],
    ] as const) {
      const app = build(status as Awaited<ReturnType<TradingSigner["getWalletStatus"]>>);
      const res = await app.inject({
        method: "GET",
        url: "/api/trading-wallet?verify=1",
        headers: { cookie: "mx2_session=tok" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Record<string, unknown>).walletHealth).toBe(expected);
      await app.close();
    }

    // Without ?verify the provider is never consulted.
    let statusCalls = 0;
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingSigner: signerWith({
        getWalletStatus: async () => {
          statusCalls++;
          return { ok: true, value: "active" as const };
        },
      }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/trading-wallet",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).walletHealth).toBeNull();
    expect(statusCalls).toBe(0);
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
      executeBatch: async () =>
        ok({ depositWalletAddress, transactionId: "batch-1", state: "STATE_EXECUTED" }),
      getTransactionState: async () => ok({ state: "STATE_CONFIRMED" }),
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

  it("POST /delegate/refresh extends an ACTIVE delegation (refresh-within-grant)", async () => {
    let created: { expiresAt: Date; sessionSignerId: string | null } | null = null;
    const delegations: DelegationStore = {
      ...mockDelegations,
      findActive: async () => makeActiveDelegationRow(),
      create: async (opts) => {
        created = { expiresAt: opts.expiresAt, sessionSignerId: opts.sessionSignerId ?? null };
        return makeActiveDelegationRow();
      },
    };
    const app = buildTestApp({ cfg: configPrivy, sessions: mockSessionsAuthed, delegations });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/delegate/refresh",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(200);
    expect(created).not.toBeNull();
    // 14-day default TTL (D-019) — well beyond the old 24h window.
    expect(created!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    await app.close();
  });

  it("POST /delegate/refresh refuses when no delegation is active (must re-consent)", async () => {
    const app = buildTestApp({
      cfg: configPrivy,
      sessions: mockSessionsAuthed,
      delegations: { ...mockDelegations, findActive: async () => null },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/trading-wallet/delegate/refresh",
      headers: { cookie: "mx2_session=tok" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Record<string, unknown>).error).toBe("DELEGATION_NOT_ACTIVE");
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

  it("POST /api/admin/quoter/pause flips the quoter-only kill switch (audited)", async () => {
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
    const events: Record<string, unknown>[] = [];
    const app = buildTestApp({
      runtimeFlags: captureFlags,
      auditStore: {
        ...mockAuditStore,
        emit: async (e) => {
          events.push({ action: e.action, metadata: e.metadata });
          return mockAuditStore.emit(e);
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/quoter/pause",
      headers: { "x-admin-secret": "test-admin-secret-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quoterPaused).toBe(true);
    expect(capturedKey).toBe("quoter_paused");
    expect(capturedValue).toBe("true");
    expect(events).toContainEqual({
      action: "kill_switch.toggled",
      metadata: { flag: "quoter_paused", switch: "quoter" },
    });
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
  it("blocks order submission from blocked IP", async () => {
    const blockedGeoblock: GeoblockClient = {
      check: async (ip) => ok({ status: "blocked", country: "RU", region: null, ip }),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, geoblockClient: blockedGeoblock });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
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

  it("blocks close_only region from placing new orders", async () => {
    const closeOnlyGeoblock: GeoblockClient = {
      check: async (ip) => ok({ status: "close_only", country: "SG", region: null, ip }),
    };
    const app = buildTestApp({ sessions: mockSessionsAuthed, geoblockClient: closeOnlyGeoblock });
    const res = await app.inject({
      method: "POST",
      url: "/api/trade/orders",
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
      url: "/api/trade/orders",
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

// ── Owner-only withdrawals (R6 Track A) ─────────────────────────────────────

describe("POST /api/trading-wallet/withdraw", () => {
  const DEPOSIT = "0x9999999999999999999999999999999999999999";

  const configWithdraw = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
    TRADING_ADMIN_SECRET: "test-admin-secret-123",
    FEATURE_LIVE_TRADING: "true",
    FEATURE_PRIVY_SIGNING: "true",
    FEATURE_RELAYER: "true",
    FEATURE_WALLET_WITHDRAW: "true",
    MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    POLYGON_RPC_URL: "https://polygon.example.test",
    POLYMARKET_RELAYER_URL: "https://relayer.example.test",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  });

  const internalAccount = () =>
    makeTradingAccountRow({
      id: "acct-int",
      kind: "internal_privy",
      signerAddress: "0x1111111111111111111111111111111111111111",
      privyWalletId: "pw-test",
      depositWalletAddress: DEPOSIT,
      status: "ready",
    });

  const makeWithdrawalStoreMock = () => {
    const rows = new Map<string, Record<string, unknown>>();
    const store: WithdrawalStore = {
      create: async (opts) => {
        if (rows.has(opts.idempotencyKey)) return null;
        const row = {
          id: `wd-${rows.size + 1}`,
          walletAddress: opts.walletAddress.toLowerCase(),
          depositWalletAddress: opts.depositWalletAddress,
          destinationAddress: opts.destinationAddress.toLowerCase(),
          amountUsd: String(opts.amountUsd),
          state: "requested",
          relayerTransactionId: null,
          transactionHash: null,
          error: null,
          idempotencyKey: opts.idempotencyKey,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(opts.idempotencyKey, row);
        return row as never;
      },
      updateState: async (id, update) => {
        for (const row of rows.values()) {
          if (row["id"] === id) Object.assign(row, update);
        }
      },
      findByIdempotencyKey: async (_w, key) => (rows.get(key) as never) ?? null,
      listByWallet: async () => [...rows.values()] as never,
    };
    return { store, rows };
  };

  const withdrawHarness = (
    over: {
      cfg?: ReturnType<typeof loadConfig>;
      balanceRaw?: bigint;
      batchFails?: boolean;
      reader?: AllowanceReader;
      accounts?: TradingAccountRow[];
    } = {},
  ) => {
    const { events, auditStore } = (() => {
      const events: string[] = [];
      return {
        events,
        auditStore: {
          ...mockAuditStore,
          emit: async (e: Parameters<AuditStore["emit"]>[0]) => {
            events.push(e.action);
            return mockAuditStore.emit(e);
          },
        } as AuditStore,
      };
    })();
    const batches: { calls: { target: string; value: string; data: string }[] }[] = [];
    const relayer: DepositWalletRelayer = {
      enabled: true,
      deriveDepositWalletAddress: async (owner) =>
        ok({ ownerAddress: owner.ownerAddress, depositWalletAddress: DEPOSIT }),
      getDeploymentStatus: async (owner) =>
        ok({
          ownerAddress: owner.ownerAddress,
          depositWalletAddress: DEPOSIT,
          deployed: true,
          state: "STATE_CONFIRMED",
        }),
      deployDepositWallet: async () => {
        throw new Error("not needed");
      },
      executeBatch: async (_owner, calls) => {
        if (over.batchFails) {
          return {
            ok: false as const,
            error: { code: "RELAYER_UPSTREAM_ERROR" as const, message: "boom" },
          };
        }
        batches.push({ calls });
        return ok({
          depositWalletAddress: DEPOSIT,
          transactionId: "batch-77",
          state: "STATE_EXECUTED",
        });
      },
      getTransactionState: async () => ok({ state: "STATE_CONFIRMED" }),
    };
    const { store } = makeWithdrawalStoreMock();
    const app = buildTestApp({
      cfg: over.cfg ?? configWithdraw,
      sessions: mockSessionsAuthed,
      auditStore,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingAccounts: {
        ...mockTradingAccounts,
        listByOwner: async () => over.accounts ?? [internalAccount()],
      },
      depositWalletRelayer: relayer,
      withdrawals: store,
      allowanceReader: over.reader ?? {
        erc20Allowance: async () => 0n,
        isApprovedForAll: async () => false,
        erc20Balance: async () => over.balanceRaw ?? 100_000_000n, // $100
      },
    });
    return { app, events, batches };
  };

  const post = (app: ReturnType<typeof buildTestApp>, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/trading-wallet/withdraw",
      headers: { cookie: "mx2_session=tok", "content-type": "application/json" },
      payload,
    });

  it("503s when the withdraw flag is off", async () => {
    const { app } = withdrawHarness({ cfg: configRelayer });
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-1234567890" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("WALLET_WITHDRAW_DISABLED");
    await app.close();
  });

  it("rejects a smuggled destination field (strict schema)", async () => {
    const { app, batches } = withdrawHarness();
    const res = await post(app, {
      amountUsd: 5,
      idempotencyKey: "k-1234567890",
      destination: "0xattacker0000000000000000000000000000dead",
    });
    expect(res.statusCode).toBe(400);
    expect(batches).toHaveLength(0);
    await app.close();
  });

  it("400s when the amount exceeds the on-chain balance", async () => {
    const { app, batches } = withdrawHarness({ balanceRaw: 3_000_000n }); // $3
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-1234567890" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INSUFFICIENT_BALANCE");
    expect(res.json().availableUsd).toBe(3);
    expect(batches).toHaveLength(0);
    await app.close();
  });

  it("withdraws to the SESSION wallet only, with audit chain + ledger", async () => {
    const { app, events, batches } = withdrawHarness();
    const res = await post(app, { amountUsd: 2.5, idempotencyKey: "k-1234567890" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.destination).toBe(WALLET);
    expect(body.relayer.transactionId).toBe("batch-77");

    // Exactly one batch call: pUSD.transfer(sessionWallet, 2.5e6) — deposit
    // wallets hold pUSD, not USDC.e (INTEGRATION_VERIFIED §23).
    expect(batches).toHaveLength(1);
    const call = batches[0]!.calls[0]!;
    expect(call.target.toLowerCase()).toBe("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
    expect(call.data.slice(0, 10)).toBe("0xa9059cbb"); // transfer selector
    // address word (32 bytes) contains the session wallet
    expect(call.data.slice(10, 74).toLowerCase()).toContain(WALLET.slice(2).toLowerCase());
    // amount word = 2_500_000 (0x2625a0)
    expect(BigInt(`0x${call.data.slice(74, 138)}`)).toBe(2_500_000n);

    expect(events).toContain("wallet.withdraw.requested");
    expect(events).toContain("wallet.withdraw.submitted");
    await app.close();
  });

  it("is idempotent — the same key never reaches the relayer twice", async () => {
    const { app, batches } = withdrawHarness();
    const first = await post(app, { amountUsd: 2, idempotencyKey: "k-repeat-123" });
    expect(first.statusCode).toBe(200);
    const second = await post(app, { amountUsd: 2, idempotencyKey: "k-repeat-123" });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadySubmitted).toBe(true);
    expect(batches).toHaveLength(1);
    await app.close();
  });

  it("marks the ledger failed and audits when the relayer errors", async () => {
    const { app, events } = withdrawHarness({ batchFails: true });
    const res = await post(app, { amountUsd: 2, idempotencyKey: "k-fail-1234" });
    expect(res.statusCode).toBe(502);
    expect(events).toContain("wallet.withdraw.failed");
    await app.close();
  });

  // ── Cross-chain (bridge) withdrawals — chain choice, login wallet only ─────

  const BRIDGE_HOP = "0x5555555555555555555555555555555555555555";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  const configBridgeWithdraw = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
    TRADING_ADMIN_SECRET: "test-admin-secret-123",
    FEATURE_LIVE_TRADING: "true",
    FEATURE_PRIVY_SIGNING: "true",
    FEATURE_RELAYER: "true",
    FEATURE_WALLET_WITHDRAW: "true",
    FEATURE_BRIDGE_WITHDRAWALS: "true",
    MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    POLYGON_RPC_URL: "https://polygon.example.test",
    POLYMARKET_RELAYER_URL: "https://relayer.example.test",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  });

  const makeBridgeStoreMock = () => {
    const rows = new Map<string, BridgeWithdrawalRow>();
    const store: BridgeStore = {
      saveAddress: async (row) =>
        ({
          id: "baddr-1",
          walletAddress: row.walletAddress,
          depositWalletAddress: row.depositWalletAddress,
          kind: row.kind ?? "deposit",
          addressType: row.addressType,
          address: row.address,
          toChainId: row.toChainId ?? null,
          toTokenAddress: row.toTokenAddress ?? null,
          recipientAddress: row.recipientAddress ?? null,
          lastCheckedAt: null,
          createdAt: new Date(),
        }) as never,
      listAddresses: async () => [],
      listPollableAddresses: async () => [],
      markAddressChecked: async () => {},
      upsertDepositsFromStatus: async () => ({ changed: [] }),
      listDepositsByWallet: async () => [],
      createWithdrawal: async (row) => {
        if (rows.has(row.idempotencyKey)) return null;
        const created = {
          id: `bw-${rows.size + 1}`,
          walletAddress: row.walletAddress,
          depositWalletAddress: row.depositWalletAddress,
          destinationAddress: row.destinationAddress,
          toChainId: row.toChainId,
          toTokenAddress: row.toTokenAddress,
          bridgeAddressId: null,
          amountUsd: row.amountUsd,
          quoteId: null,
          estToTokenBaseUnit: null,
          state: "requested",
          relayerTransactionId: null,
          polygonTxHash: null,
          bridgeTxHash: null,
          error: null,
          idempotencyKey: row.idempotencyKey,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as BridgeWithdrawalRow;
        rows.set(row.idempotencyKey, created);
        return created;
      },
      findWithdrawalByIdempotencyKey: async (_w, key) => rows.get(key) ?? null,
      listWithdrawalsByWallet: async () => [...rows.values()],
      updateWithdrawalState: async (id, state, patch) => {
        for (const row of rows.values()) {
          if (row.id === id) {
            Object.assign(row, { state, ...(patch ?? {}) });
            return row;
          }
        }
        return null;
      },
      updateWithdrawalsFromStatus: async () => ({ changed: [] }),
    };
    return { store, rows };
  };

  const makeBridgeClientMock = (over: { minReceived?: number } = {}): BridgeClient => ({
    getSupportedAssets: async () =>
      ok({
        supportedAssets: [
          {
            chainId: "8453",
            chainName: "Base",
            token: { name: "USDC", symbol: "USDC", address: BASE_USDC, decimals: 6 },
            minCheckoutUsd: 2,
          },
        ],
      }),
    createDepositAddresses: async () => ok({ evm: BRIDGE_HOP }),
    getQuote: async () =>
      ok({
        quoteId: "q-9",
        estCheckoutTimeMs: 60_000,
        estOutputUsd: over.minReceived ?? 4.97,
        estFeeBreakdown: { minReceived: over.minReceived ?? 4.97 },
      }),
    createWithdrawalAddresses: async () => ok({ evm: BRIDGE_HOP }),
    getStatus: async () => ok({ transactions: [] }),
  });

  const bridgeApp = (over: { minReceived?: number; cfg?: ReturnType<typeof loadConfig> } = {}) => {
    const bridge = makeBridgeStoreMock();
    const events: string[] = [];
    const batches: { calls: { target: string; value: string; data: string }[] }[] = [];
    const relayer: DepositWalletRelayer = {
      enabled: true,
      deriveDepositWalletAddress: async (owner) =>
        ok({ ownerAddress: owner.ownerAddress, depositWalletAddress: DEPOSIT }),
      getDeploymentStatus: async (owner) =>
        ok({
          ownerAddress: owner.ownerAddress,
          depositWalletAddress: DEPOSIT,
          deployed: true,
          state: "STATE_CONFIRMED",
        }),
      deployDepositWallet: async () => {
        throw new Error("not needed");
      },
      executeBatch: async (_owner, calls) => {
        batches.push({ calls });
        return ok({
          depositWalletAddress: DEPOSIT,
          transactionId: "batch-88",
          state: "STATE_EXECUTED",
        });
      },
      getTransactionState: async () => ok({ state: "STATE_CONFIRMED" }),
    };
    const app = buildTestApp({
      cfg: over.cfg ?? configBridgeWithdraw,
      sessions: mockSessionsAuthed,
      auditStore: {
        ...mockAuditStore,
        emit: async (e: Parameters<AuditStore["emit"]>[0]) => {
          events.push(e.action);
          return mockAuditStore.emit(e);
        },
      } as AuditStore,
      privyWallets: { ...mockPrivyWallets, find: async () => makePrivyWalletRow() },
      tradingAccounts: { ...mockTradingAccounts, listByOwner: async () => [internalAccount()] },
      depositWalletRelayer: relayer,
      withdrawals: makeWithdrawalStoreMock().store,
      bridgeClient: makeBridgeClientMock(over),
      bridgeStore: bridge.store,
      allowanceReader: {
        erc20Allowance: async () => 0n,
        isApprovedForAll: async () => false,
        erc20Balance: async () => 100_000_000n, // $100
      },
    });
    return { app, events, batches, bridge };
  };

  it("503s cross-chain withdrawals when the bridge flag is off", async () => {
    const { app } = bridgeApp({ cfg: configWithdraw });
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-000000", toChainId: "8453" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("BRIDGE_WITHDRAWALS_DISABLED");
    await app.close();
  });

  it("routes the Polygon leg to the BRIDGE address, destination stays the session wallet", async () => {
    const { app, events, batches, bridge } = bridgeApp();
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-111111", toChainId: "8453" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.toChainId).toBe("8453");
    expect(body.destination).toBe(WALLET); // login wallet — never client input
    expect(body.quote.minReceived).toBe(4.97);

    // pUSD.transfer(bridgeHopAddress, 5e6): funds go to the bridge hop, and
    // the bridge delivers USDC to the login wallet on Base.
    expect(batches).toHaveLength(1);
    const call = batches[0]!.calls[0]!;
    expect(call.target.toLowerCase()).toBe("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
    expect(call.data.slice(10, 74).toLowerCase()).toContain(BRIDGE_HOP.slice(2).toLowerCase());

    const row = [...bridge.rows.values()][0]!;
    expect(row.state).toBe("polygon_submitted");
    expect(events).toContain("wallet.bridge.withdraw_requested");
    expect(events).toContain("wallet.bridge.withdraw_address_created");
    expect(events).toContain("wallet.bridge.withdraw_submitted");
    await app.close();
  });

  it("refuses when the quote's minReceived drops more than 1% below the amount", async () => {
    const { app, batches, bridge } = bridgeApp({ minReceived: 4.5 });
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-222222", toChainId: "8453" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("QUOTE_TOO_LOW");
    expect(batches).toHaveLength(0); // funds never moved
    expect([...bridge.rows.values()][0]!.state).toBe("failed_address");
    await app.close();
  });

  it("is idempotent per key across the bridge path", async () => {
    const { app, batches } = bridgeApp();
    const first = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-333333", toChainId: "8453" });
    expect(first.statusCode).toBe(200);
    const second = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-333333", toChainId: "8453" });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadySubmitted).toBe(true);
    expect(batches).toHaveLength(1);
    await app.close();
  });

  it("400s for a chain the bridge has no USD asset on", async () => {
    const { app, batches } = bridgeApp();
    const res = await post(app, { amountUsd: 5, idempotencyKey: "k-bw-444444", toChainId: "999" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNSUPPORTED_CHAIN");
    expect(batches).toHaveLength(0);
    await app.close();
  });
});

describe("POST /api/trading-wallet/bootstrap-allowances (deposit-wallet path, W2)", () => {
  // Reuses the withdraw describe's constants via module scope is not possible —
  // redeclare the essentials locally.
  const DEPOSIT = "0x9999999999999999999999999999999999999999";
  const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
  const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

  const cfgRelayer = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_ENCRYPTION_MASTER_KEY: ENCRYPTION_KEY,
    TRADING_ADMIN_SECRET: "test-admin-secret-123",
    FEATURE_PRIVY_SIGNING: "true",
    FEATURE_RELAYER: "true",
    MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    POLYGON_RPC_URL: "https://polygon.example.test",
    POLYMARKET_RELAYER_URL: "https://relayer.example.test",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  });

  const harness = (
    over: {
      reader?: AllowanceReader;
      accounts?: TradingAccountRow[];
      batchFails?: boolean;
    } = {},
  ) => {
    const events: string[] = [];
    const auditStore = {
      ...mockAuditStore,
      emit: async (e: Parameters<AuditStore["emit"]>[0]) => {
        events.push(e.action);
        return mockAuditStore.emit(e);
      },
    } as AuditStore;
    const batches: { calls: { target: string; value: string; data: string }[] }[] = [];
    const relayer: DepositWalletRelayer = {
      enabled: true,
      deriveDepositWalletAddress: async (owner) =>
        ok({ ownerAddress: owner.ownerAddress, depositWalletAddress: DEPOSIT }),
      getDeploymentStatus: async (owner) =>
        ok({
          ownerAddress: owner.ownerAddress,
          depositWalletAddress: DEPOSIT,
          deployed: true,
          state: "STATE_CONFIRMED",
        }),
      deployDepositWallet: async () => {
        throw new Error("not needed");
      },
      executeBatch: async (_owner, calls) => {
        if (over.batchFails) {
          return {
            ok: false as const,
            error: { code: "RELAYER_UPSTREAM_ERROR" as const, message: "boom" },
          };
        }
        batches.push({ calls });
        return ok({
          depositWalletAddress: DEPOSIT,
          transactionId: "batch-allow-1",
          state: "STATE_EXECUTED",
        });
      },
      getTransactionState: async () => ok({ state: "STATE_CONFIRMED" }),
    };
    const marked: string[] = [];
    const app = buildTestApp({
      cfg: cfgRelayer,
      sessions: mockSessionsAuthed,
      auditStore,
      privyWallets: {
        ...mockPrivyWallets,
        find: async () => ({ ...makePrivyWalletRow(), allowancesBootstrappedAt: null }),
        markAllowancesBootstrapped: async (w) => {
          marked.push(w);
        },
      },
      tradingAccounts: {
        ...mockTradingAccounts,
        listByOwner: async () =>
          over.accounts ?? [
            makeTradingAccountRow({
              id: "acct-int",
              kind: "internal_privy",
              signerAddress: "0x1111111111111111111111111111111111111111",
              privyWalletId: "pw-test",
              depositWalletAddress: DEPOSIT,
              status: "ready",
            }),
          ],
      },
      depositWalletRelayer: relayer,
      allowanceReader: over.reader ?? {
        erc20Allowance: async () => 0n,
        isApprovedForAll: async () => false,
        erc20Balance: async () => 0n,
      },
    });
    return { app, events, batches, marked };
  };

  const post = (app: ReturnType<typeof buildTestApp>) =>
    app.inject({
      method: "POST",
      url: "/api/trading-wallet/bootstrap-allowances",
      headers: { cookie: "mx2_session=tok", "content-type": "application/json" },
      payload: {},
    });

  it("409s until the deposit wallet exists", async () => {
    const { app, batches } = harness({ accounts: [] });
    const res = await post(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("DEPOSIT_WALLET_REQUIRED");
    expect(batches).toHaveLength(0);
    await app.close();
  });

  it("submits ONE batch containing exactly the missing grants (pUSD approve + CTF operator)", async () => {
    const { app, events, batches, marked } = harness();
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alreadyBootstrapped).toBe(false);
    // No adapters configured → 2 exchanges × (collateral + ctf) = 4 grants.
    expect(body.submitted).toHaveLength(4);
    expect(batches).toHaveLength(1);
    const calls = batches[0]!.calls;
    expect(calls).toHaveLength(4);
    const approveCalls = calls.filter((c) => c.data.startsWith("0x095ea7b3")); // approve
    const operatorCalls = calls.filter((c) => c.data.startsWith("0xa22cb465")); // setApprovalForAll
    expect(approveCalls).toHaveLength(2);
    expect(operatorCalls).toHaveLength(2);
    for (const c of approveCalls) expect(c.target.toLowerCase()).toBe(PUSD);
    for (const c of operatorCalls) expect(c.target.toLowerCase()).toBe(CTF);
    expect(events).toContain("allowance.approve.submitted");
    expect(marked).toHaveLength(1);
    await app.close();
  });

  it("no-ops when the chain already holds every grant (chain = source of truth)", async () => {
    const { app, batches } = harness({
      reader: {
        erc20Allowance: async () => 2n ** 255n,
        isApprovedForAll: async () => true,
        erc20Balance: async () => 0n,
      },
    });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyBootstrapped).toBe(true);
    expect(batches).toHaveLength(0);
    await app.close();
  });

  it("submits only the gaps on a partially-approved wallet", async () => {
    // Exchange grants present; simulate a wallet where only the CTF operator
    // grant for the neg-risk exchange is missing.
    const { app, batches } = harness({
      reader: {
        erc20Allowance: async () => 2n ** 255n,
        isApprovedForAll: async (_t, _o, operator) =>
          operator.toLowerCase() !== "0xe2222d279d744050d28e00520010520000310f59",
        erc20Balance: async () => 0n,
      },
    });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().submitted).toEqual(["neg_risk_exchange_v2:ctf"]);
    expect(batches[0]!.calls).toHaveLength(1);
    await app.close();
  });

  it("502s and audits when the relayer batch fails (nothing marked)", async () => {
    const { app, events, marked } = harness({ batchFails: true });
    const res = await post(app);
    expect(res.statusCode).toBe(502);
    expect(events).toContain("allowance.failed");
    expect(marked).toHaveLength(0);
    await app.close();
  });
});
