import { describe, it, expect, beforeEach } from "vitest";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  AllowlistStore,
  ChallengeStore,
  ClobCredentialStore,
  ConditionalRuleRow,
  MarketSnapshotRow,
  MarketSnapshotStore,
  OrderIntentStore,
  RuleStore,
  RuntimeFlagStore,
  SessionStore,
  TriggerStore,
  UserStore,
  PrivyWalletStore,
  DelegationStore,
} from "@mx2/db";
import {
  GammaEventSchema,
  type AuthenticatedClobClient,
  type ClobClient,
  type DataClient,
  type GammaClient,
  type GammaMarket,
  type GeoblockClient,
  type PolymarketError,
} from "@mx2/polymarket-client";
import type { ExprNode } from "@mx2/rules";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import { buildApp, type DbProbe } from "../app.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const COOKIE = "mx2_session=tok";
const logger = createLogger({ name: "smart-orders-test", level: "silent" });
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

// ── In-memory rule store (create/list/find only — controls covered in rules.test) ──

const makeRuleStore = (): RuleStore & { rows: ConditionalRuleRow[] } => {
  const rows: ConditionalRuleRow[] = [];
  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  return {
    rows,
    create: async (o) => {
      const row: ConditionalRuleRow = {
        id: `rule-${rows.length + 1}`,
        walletAddress: o.walletAddress,
        conditionId: o.conditionId,
        tokenId: o.tokenId,
        side: o.side,
        definition: o.definition,
        definitionHash: o.definitionHash,
        status: "ACTIVE_WAITING",
        version: o.version ?? 1,
        trueSince: null,
        expiresAt: o.expiresAt,
        pausedAt: null,
        lastEvaluatedAt: null,
        errorMessage: null,
        name: o.name ?? null,
        templateId: o.templateId ?? null,
        tokenIds: [...(o.tokenIds ?? [o.tokenId])],
        triggerCount: 0,
        cooldownUntil: null,
        totalNotionalExecuted: "0",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return row;
    },
    findById: async (id) => find(id),
    findByIdForWallet: async (id, w) => {
      const r = find(id);
      return r && r.walletAddress === w ? r : null;
    },
    listByWallet: async (w) => rows.filter((r) => r.walletAddress === w),
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
};

const snapshotFor = (
  tokenId: string,
  over: Partial<MarketSnapshotRow> = {},
): MarketSnapshotRow => ({
  tokenId,
  conditionId: `cond-${tokenId}`,
  bids: [{ price: "0.47", size: "500" }],
  asks: [
    { price: "0.48", size: "1000" },
    { price: "0.49", size: "1000" },
  ],
  lastTradePrice: null,
  midPrice: "0.475",
  source: "ws",
  isStale: false,
  receivedAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const gammaMarketFor = (tokenId: string, conditionId: string): GammaMarket =>
  ({
    id: `m-${tokenId}`,
    question: "Test market?",
    description: "",
    conditionId,
    slug: "",
    image: "",
    icon: "",
    active: true,
    closed: false,
    archived: false,
    restricted: false,
    new: false,
    featured: false,
    acceptingOrders: true,
    liquidity: "1000",
    volume: "1000",
    openInterest: "0",
    lastTradePrice: "0.5",
    bestBid: "0.47",
    bestAsk: "0.48",
    spread: "0.01",
    status: "open",
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.48","0.52"]',
    clobTokenIds: `["${tokenId}","${tokenId}-no"]`,
  }) as GammaMarket;

const buildSmartOrdersApp = (opts: {
  smartOrdersV2?: boolean;
  ruleStore?: ReturnType<typeof makeRuleStore>;
  snapshots?: Record<string, MarketSnapshotRow>;
  findMarket?: GammaClient["findMarket"];
  searchMarkets?: GammaClient["searchMarkets"];
}) => {
  const ruleStore = opts.ruleStore ?? makeRuleStore();
  const audits: { action: string; subject: string | null }[] = [];

  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    FEATURE_SMART_ORDERS_V2: opts.smartOrdersV2 === false ? "false" : "true",
  });

  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push({ action: e.action, subject: e.subject ?? null });
      return {
        id: "a",
        actor: e.actor,
        action: e.action,
        subject: e.subject ?? null,
        metadata: e.metadata,
        createdAt: new Date(),
      };
    },
    recent: async () => [],
    forActor: async () => [],
  };
  const sessions: SessionStore = {
    create: async () => {
      throw new Error("no");
    },
    findByTokenHash: async () => ({
      id: "s1",
      userWallet: WALLET,
      tokenHash: "h",
      expiresAt: new Date(Date.now() + 1_000_000),
      createdAt: new Date(),
      revokedAt: null,
    }),
    revoke: async () => {},
  };
  const marketSnapshots: MarketSnapshotStore = {
    upsert: async () => {
      throw new Error("no");
    },
    findByTokenId: async (tokenId) => opts.snapshots?.[tokenId] ?? null,
    markStale: async () => {},
  };
  const gamma: GammaClient = {
    listEvents: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket:
      opts.findMarket ??
      (async (p) => ok(p.tokenId ? gammaMarketFor(p.tokenId, `cond-${p.tokenId}`) : null)),
    searchMarkets: opts.searchMarkets ?? (async () => ok([])),
  };
  const clob: ClobClient = {
    getOrderbook: async () => err(upstreamErr),
    getTrades: async () => err(upstreamErr),
    getPrices: async () => err(upstreamErr),
    getLastTradePrice: async () => err(upstreamErr),
    getPricesHistory: async () => err(upstreamErr),
  };
  const data: DataClient = {
    getPositions: async () => ok([]),
    getClosedPositions: async () => ok([]),
    getActivity: async () => ok([]),
    getPositionValue: async () => ok(null),
    getLeaderboardEntry: async () => ok(null),
  };
  const trading: AuthenticatedClobClient = {
    getServerTime: async () => ok(0),
    deriveApiKey: async () => err(upstreamErr),
    getBalanceAllowance: async () => err(upstreamErr),
    submitOrder: async () => err(upstreamErr),
    cancelOrder: async () => err(upstreamErr),
    getOpenOrders: async () => ok([]),
  };
  const geo: GeoblockClient = {
    check: async (ip) => ok({ status: "allowed", country: "DE", region: null, ip }),
  };
  const noop = {
    users: {
      upsert: async () => ({
        walletAddress: WALLET,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      }),
      findByWallet: async () => null,
    } satisfies UserStore,
    challenges: {
      create: async () => {
        throw new Error("no");
      },
      findByNonce: async () => null,
      markUsed: async () => {},
    } satisfies ChallengeStore,
    allowlist: {
      isAllowed: async () => true,
      findEntry: async () => null,
      add: async () => {
        throw new Error("no");
      },
      remove: async () => {},
    } satisfies AllowlistStore,
    creds: {
      upsert: async () => {
        throw new Error("no");
      },
      find: async () => null,
      delete: async () => {},
    } satisfies ClobCredentialStore,
    intents: {
      create: async () => {
        throw new Error("no");
      },
      findByIdempotencyKey: async () => null,
      findById: async () => null,
      listByWallet: async () => [],
      updateStatus: async () => {},
      countRecentByWallet: async () => 0,
      sumRuleAutoNotional: async () => 0,
    } satisfies OrderIntentStore,
    flags: {
      get: async () => null,
      set: async (k, v, by) => ({ key: k, value: v, updatedBy: by, updatedAt: new Date() }),
    } satisfies RuntimeFlagStore,
    triggers: {
      create: async () => {
        throw new Error("no");
      },
      findById: async () => null,
      findByIdForWallet: async () => null,
      listByWallet: async () => [],
      listAwaiting: async () => [],
      hasForRule: async () => false,
      updateStatus: async () => {},
    } satisfies TriggerStore,
    privyWallets: {
      upsert: async () => {
        throw new Error("no");
      },
      find: async () => null,
      markAllowancesBootstrapped: async () => {},
    } satisfies PrivyWalletStore,
    delegations: {
      create: async () => {
        throw new Error("no");
      },
      findActive: async () => null,
      revoke: async () => {},
      expireLapsed: async () => {},
    } satisfies DelegationStore,
  };
  const signer: TradingSigner = createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` });

  const app = buildApp({
    config,
    logger,
    db: { ping: async () => true } satisfies DbProbe,
    auditStore,
    marketSnapshots,
    challenges: noop.challenges,
    users: noop.users,
    sessions,
    allowlist: noop.allowlist,
    clobCredentials: noop.creds,
    orderIntents: noop.intents,
    runtimeFlags: noop.flags,
    ruleStore,
    triggerStore: noop.triggers,
    privyWallets: noop.privyWallets,
    delegations: noop.delegations,
    gammaClient: gamma,
    clobClient: clob,
    dataClient: data,
    tradingClobClient: trading,
    tradingSigner: signer,
    geoblockClient: geo,
  });

  return { app, ruleStore, audits };
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

const marketRef = (tokenId: string) => ({
  conditionId: `cond-${tokenId}`,
  tokenId,
  outcome: "YES",
});

const priceLeaf = (id: string, tokenId: string, threshold = 0.5): ExprNode => ({
  type: "condition",
  id,
  condition: {
    kind: "price",
    market: marketRef(tokenId),
    source: "ask",
    comparator: "lte",
    threshold,
  },
});

const validBody = {
  name: "Buy the dip",
  templateId: "re-entry",
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [priceLeaf("p1", "tok-1")],
  },
  holdsForMs: 300_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: marketRef("tok-1"),
    side: "BUY",
    price: 0.49,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
};

beforeEach(() => resetRateLimits());

describe("POST /api/smart-orders", () => {
  it("fails closed when the v2 flag is off", async () => {
    const { app } = buildSmartOrdersApp({ smartOrdersV2: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("SMART_ORDERS_DISABLED");
    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json" },
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a v2 strategy, audits it, and serializes definitionV2", async () => {
    const { app, ruleStore, audits } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.version).toBe(2);
    expect(body.name).toBe("Buy the dip");
    expect(body.tokenIds).toEqual(["tok-1"]);
    expect(body.definitionV2.version).toBe(2);
    expect(audits.some((a) => a.action === "rule.created")).toBe(true);
    expect(ruleStore.rows[0]!.definitionHash).toMatch(/^[0-9a-f]{8}$/);
    await app.close();
  });

  it("rejects auto execution without limits (arm-time validation)", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        ...validBody,
        action: { ...validBody.action, execution: "auto" },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("INVALID_STRATEGY");
    expect(body.issues.map((i: { code: string }) => i.code)).toContain("AUTO_REQUIRES_LIMITS");
    await app.close();
  });

  it("rejects expressions beyond the structural caps", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        ...validBody,
        expr: {
          type: "group",
          id: "g1",
          op: "and",
          children: [
            {
              type: "group",
              id: "g2",
              op: "or",
              children: [
                { type: "group", id: "g3", op: "and", children: [priceLeaf("p1", "tok-1")] },
              ],
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { code: string }) => i.code)).toContain("EXPR_TOO_DEEP");
    await app.close();
  });

  it("rejects a tokenId that does not belong to the claimed market", async () => {
    const { app } = buildSmartOrdersApp({
      findMarket: async (p) => ok(p.tokenId ? gammaMarketFor(p.tokenId, "cond-OTHER") : null),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validBody,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MARKET_MISMATCH");
    await app.close();
  });

  it("fails closed when the market lookup errors", async () => {
    const { app } = buildSmartOrdersApp({ findMarket: async () => err(upstreamErr) });
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validBody,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("MARKET_LOOKUP_FAILED");
    await app.close();
  });
});

describe("GET /api/smart-orders (+ v1 normalization)", () => {
  it("lists v1 rules alongside v2 with a normalized definitionV2", async () => {
    const ruleStore = makeRuleStore();
    await ruleStore.create({
      walletAddress: WALLET,
      conditionId: "cond-tok-1",
      tokenId: "tok-1",
      side: "BUY",
      definition: {
        version: 1,
        tokenId: "tok-1",
        conditionId: "cond-tok-1",
        outcomeSide: "BUY",
        predicates: [{ kind: "price", source: "ask", comparator: "lte", threshold: 0.5 }],
        continuousWindowMs: 600_000,
        maxDataAgeMs: 2_000,
        action: { kind: "prepare_order", side: "BUY", price: 0.49, size: 100, orderType: "GTC" },
        recurrence: "once",
        expiresAtMs: null,
      },
      definitionHash: "deadbeef",
      expiresAt: null,
    });
    const { app } = buildSmartOrdersApp({ ruleStore });
    const res = await app.inject({
      method: "GET",
      url: "/api/smart-orders",
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const { strategies } = res.json();
    expect(strategies).toHaveLength(1);
    expect(strategies[0].version).toBe(1);
    expect(strategies[0].definitionV2.version).toBe(2);
    expect(strategies[0].definitionV2.expr.op).toBe("and");
    await app.close();
  });
});

describe("POST /api/smart-orders/evaluate-draft (public)", () => {
  const draft = {
    expr: {
      type: "group",
      id: "root",
      op: "and",
      children: [priceLeaf("p1", "tok-1")],
    },
    maxDataAgeMs: 60_000,
  };

  it("evaluates a draft without authentication using worker snapshots", async () => {
    const { app } = buildSmartOrdersApp({ snapshots: { "tok-1": snapshotFor("tok-1") } });
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders/evaluate-draft",
      headers: { "content-type": "application/json" },
      payload: draft,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.satisfied).toBe(true); // best ask 0.48 ≤ 0.5, fresh
    expect(body.root.satisfied).toBe(true);
    expect(body.markets[0].tokenId).toBe("tok-1");
    await app.close();
  });

  it("fails closed (unsatisfied + stale) when no data exists for a market", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders/evaluate-draft",
      headers: { "content-type": "application/json" },
      payload: draft,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.satisfied).toBe(false);
    expect(body.staleTokenIds).toEqual(["tok-1"]);
    await app.close();
  });

  it("rejects drafts referencing too many markets", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/smart-orders/evaluate-draft",
      headers: { "content-type": "application/json" },
      payload: {
        expr: {
          type: "group",
          id: "root",
          op: "and",
          children: ["a", "b", "c", "d", "e"].map((t, i) => priceLeaf(`p${i}`, `tok-${t}`)),
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { code: string }) => i.code)).toContain(
      "EXPR_TOO_MANY_MARKETS",
    );
    await app.close();
  });

  it("rate limits repeated draft evaluations per IP", async () => {
    const { app } = buildSmartOrdersApp({ snapshots: { "tok-1": snapshotFor("tok-1") } });
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/smart-orders/evaluate-draft",
        headers: { "content-type": "application/json" },
        payload: draft,
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    await app.close();
  });
});

describe("GET /api/markets/search (public)", () => {
  it("rejects short queries", async () => {
    const { app } = buildSmartOrdersApp({});
    const res = await app.inject({ method: "GET", url: "/api/markets/search?q=a" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns compact market results with parsed token ids", async () => {
    const event = GammaEventSchema.parse({
      id: "ev-1",
      title: "Will it rain tomorrow?",
      markets: [gammaMarketFor("tok-9", "cond-tok-9")],
    });
    const { app } = buildSmartOrdersApp({ searchMarkets: async () => ok([event]) });
    const res = await app.inject({ method: "GET", url: "/api/markets/search?q=rain" });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Will it rain tomorrow?");
    expect(results[0].conditionId).toBe("cond-tok-9");
    expect(results[0].tokenIds).toEqual(["tok-9", "tok-9-no"]);
    expect(results[0].outcomes).toEqual(["Yes", "No"]);
    await app.close();
  });
});

describe("POST /api/smart-orders/:id/disarm (per-strategy kill, W8)", () => {
  const createAuto = (app: ReturnType<typeof buildSmartOrdersApp>["app"]) =>
    app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        ...validBody,
        action: { ...validBody.action, execution: "auto" },
        limits: { maxNotionalPerOrder: 100, maxDailyNotional: 200, maxTotalNotional: 500 },
      },
    });

  it("disarms an auto strategy and audits the control", async () => {
    const { app, audits } = buildSmartOrdersApp({});
    const created = await createAuto(app);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/api/smart-orders/${id}/disarm`,
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoDisabled).toBe(true);
    expect(audits.some((a) => a.action === "rule.state_changed")).toBe(true);

    const rearm = await app.inject({
      method: "POST",
      url: `/api/smart-orders/${id}/rearm`,
      headers: { cookie: COOKIE },
    });
    expect(rearm.statusCode).toBe(200);
    expect(rearm.json().autoDisabled).toBe(false);
    await app.close();
  });

  it("refuses to disarm a strategy that is not auto", async () => {
    const { app } = buildSmartOrdersApp({});
    const created = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validBody, // prepare execution
    });
    const id = created.json().id;
    const res = await app.inject({
      method: "POST",
      url: `/api/smart-orders/${id}/disarm`,
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_AUTO");
    await app.close();
  });
});

describe("GET /api/smart-orders/:id/evaluate-now", () => {
  it("evaluates a v2 strategy across every referenced market", async () => {
    const ruleStore = makeRuleStore();
    const { app } = buildSmartOrdersApp({
      ruleStore,
      snapshots: { "tok-1": snapshotFor("tok-1"), "tok-2": snapshotFor("tok-2") },
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/smart-orders",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        ...validBody,
        expr: {
          type: "group",
          id: "root",
          op: "and",
          children: [priceLeaf("p1", "tok-1"), priceLeaf("p2", "tok-2")],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/api/smart-orders/${id}/evaluate-now`,
      headers: { cookie: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.satisfied).toBe(true);
    expect(body.markets).toHaveLength(2);
    expect(body.markets.map((m: { tokenId: string }) => m.tokenId).sort()).toEqual([
      "tok-1",
      "tok-2",
    ]);
    await app.close();
  });
});
