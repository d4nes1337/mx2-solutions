import { describe, it, expect } from "vitest";
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
  RuleTriggerRow,
  RuntimeFlagStore,
  SessionStore,
  TriggerStore,
  UserStore,
  PrivyWalletStore,
  DelegationStore,
} from "@mx2/db";
import type {
  AuthenticatedClobClient,
  ClobClient,
  DataClient,
  GammaClient,
  GeoblockClient,
  PolymarketError,
} from "@mx2/polymarket-client";
import type { RuleDefinition } from "@mx2/rules";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import { buildApp, type DbProbe } from "../app.js";

const noopPrivyWallets: PrivyWalletStore = {
  upsert: async () => {
    throw new Error("not implemented");
  },
  find: async () => null,
  markAllowancesBootstrapped: async () => {},
};
const noopDelegations: DelegationStore = {
  create: async () => {
    throw new Error("not implemented");
  },
  findActive: async () => null,
  revoke: async () => {},
  expireLapsed: async () => {},
};
const noopTradingSigner: TradingSigner = createMockTradingSigner({
  privateKey: `0x${"1".repeat(64)}`,
});

const WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const logger = createLogger({ name: "rules-test", level: "silent" });
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };
const baseConfig = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" } as const;

// ── Stateful in-memory stores ───────────────────────────────────────────────

const makeRuleStore = (): RuleStore & { rows: ConditionalRuleRow[] } => {
  const rows: ConditionalRuleRow[] = [];
  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  const evaluable = (s: string) => s === "ACTIVE_WAITING" || s === "ACTIVE_ACCUMULATING";
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
    listEvaluable: async () => rows.filter((r) => evaluable(r.status)),
    updateEvaluationState: async () => null,
    pause: async (id, w) => {
      const r = find(id);
      if (r && r.walletAddress === w && evaluable(r.status)) {
        r.status = "PAUSED";
        return r;
      }
      return null;
    },
    resume: async (id, w) => {
      const r = find(id);
      if (r && r.walletAddress === w && r.status === "PAUSED") {
        r.status = "ACTIVE_WAITING";
        return r;
      }
      return null;
    },
    cancel: async (id, w) => {
      const r = find(id);
      if (r && r.walletAddress === w && r.status !== "CANCELLED") {
        r.status = "CANCELLED";
        return r;
      }
      return null;
    },
    markExecuted: async (id, w) => {
      const r = find(id);
      if (r && r.walletAddress === w && r.status === "TRIGGERED_AWAITING_USER") {
        r.status = "EXECUTED_MANUALLY";
        return r;
      }
      return null;
    },
    markExecuting: async (id) => {
      const r = find(id);
      if (r && r.status === "TRIGGERED_AWAITING_USER") {
        r.status = "EXECUTING";
        return r;
      }
      return null;
    },
    markAutoExecuted: async (id) => {
      const r = find(id);
      if (r && r.status === "EXECUTING") {
        r.status = "EXECUTED_AUTO";
        return r;
      }
      return null;
    },
    markExecutionFailed: async (id, errorMessage) => {
      const r = find(id);
      if (r && r.status === "EXECUTING") {
        r.status = "EXECUTION_FAILED";
        r.errorMessage = errorMessage;
        return r;
      }
      return null;
    },
    addExecutedNotional: async () => {},
  };
};

const makeTriggerStore = (
  seed: RuleTriggerRow[] = [],
): TriggerStore & { rows: RuleTriggerRow[] } => {
  const rows = [...seed];
  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  return {
    rows,
    create: async (o) => {
      const row: RuleTriggerRow = {
        id: `trig-${rows.length + 1}`,
        ruleId: o.ruleId,
        walletAddress: o.walletAddress,
        triggeredAt: new Date(),
        evidence: o.evidence,
        reasonCodes: [...o.reasonCodes],
        status: "awaiting_user",
        orderIntentId: null,
        createdAt: new Date(),
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
    listAwaiting: async (w) =>
      rows.filter((r) => r.walletAddress === w && r.status === "awaiting_user"),
    hasForRule: async (ruleId) => rows.some((r) => r.ruleId === ruleId),
    updateStatus: async (id, status, opts) => {
      const r = find(id);
      if (r) {
        r.status = status;
        if (opts?.orderIntentId !== undefined) r.orderIntentId = opts.orderIntentId;
      }
    },
  };
};

const snapshot = (over: Partial<MarketSnapshotRow> = {}): MarketSnapshotRow => ({
  tokenId: "tok-1",
  conditionId: "cond-1",
  bids: [{ price: "0.47", size: "500" }],
  asks: [
    { price: "0.48", size: "1000" },
    { price: "0.49", size: "1000" },
    { price: "0.5", size: "1000" },
  ],
  lastTradePrice: null,
  midPrice: "0.475",
  source: "ws",
  isStale: false,
  receivedAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

// ── App harness ─────────────────────────────────────────────────────────────

interface Harness {
  ruleStore: ReturnType<typeof makeRuleStore>;
  triggerStore: ReturnType<typeof makeTriggerStore>;
  audits: { action: string; subject: string | null }[];
}

const buildRulesApp = (opts: {
  conditionalRules?: boolean;
  ruleStore?: ReturnType<typeof makeRuleStore>;
  triggerStore?: ReturnType<typeof makeTriggerStore>;
  snapshotRow?: MarketSnapshotRow | null;
}): { app: ReturnType<typeof buildApp>; h: Harness } => {
  const ruleStore = opts.ruleStore ?? makeRuleStore();
  const triggerStore = opts.triggerStore ?? makeTriggerStore();
  const audits: Harness["audits"] = [];

  const config = loadConfig({
    ...baseConfig,
    FEATURE_CONDITIONAL_RULES: opts.conditionalRules === false ? "false" : "true",
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
    findByTokenId: async () => (opts.snapshotRow === undefined ? null : opts.snapshotRow),
    markStale: async () => {},
  };

  const noopUsers: UserStore = {
    upsert: async () => ({ walletAddress: WALLET, createdAt: new Date(), lastSeenAt: new Date() }),
    findByWallet: async () => null,
  };
  const noopChallenges: ChallengeStore = {
    create: async () => {
      throw new Error("no");
    },
    findByNonce: async () => null,
    markUsed: async () => {},
  };
  const noopAllowlist: AllowlistStore = {
    isAllowed: async () => true,
    findEntry: async () => null,
    add: async () => {
      throw new Error("no");
    },
    remove: async () => {},
  };
  const noopCreds: ClobCredentialStore = {
    upsert: async () => {
      throw new Error("no");
    },
    find: async () => null,
    delete: async () => {},
  };
  const noopIntents: OrderIntentStore = {
    create: async () => {
      throw new Error("no");
    },
    findByIdempotencyKey: async () => null,
    findById: async () => null,
    listByWallet: async () => [],
    updateStatus: async () => {},
    countRecentByWallet: async () => 0,
    sumRuleAutoNotional: async () => 0,
  };
  const noopFlags: RuntimeFlagStore = {
    get: async () => null,
    set: async (k, v, by) => ({ key: k, value: v, updatedBy: by, updatedAt: new Date() }),
  };
  const gamma: GammaClient = {
    listEvents: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
  };
  const clob: ClobClient = {
    getOrderbook: async () => err(upstreamErr),
    getTrades: async () => err(upstreamErr),
    getPrices: async () => err(upstreamErr),
    getLastTradePrice: async () => err(upstreamErr),
    getPricesHistory: async () => err(upstreamErr),
    getClobMarket: async () => err(upstreamErr),
    getFeeRate: async () => err(upstreamErr),
    getRewardsMarket: async () => err(upstreamErr),
    getRewardsMarketsCurrent: async () => err(upstreamErr),
  };
  const data: DataClient = {
    getPositions: async () => ok([]),
    getMarketTrades: async () => ok([]),
    getHolders: async () => ok([]),
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

  const app = buildApp({
    config,
    logger,
    db: { ping: async () => true } satisfies DbProbe,
    auditStore,
    marketSnapshots,
    challenges: noopChallenges,
    users: noopUsers,
    sessions,
    allowlist: noopAllowlist,
    clobCredentials: noopCreds,
    orderIntents: noopIntents,
    runtimeFlags: noopFlags,
    ruleStore,
    triggerStore,
    privyWallets: noopPrivyWallets,
    delegations: noopDelegations,
    gammaClient: gamma,
    clobClient: clob,
    dataClient: data,
    tradingClobClient: trading,
    tradingSigner: noopTradingSigner,
    geoblockClient: geo,
  });

  return { app, h: { ruleStore, triggerStore, audits } };
};

const COOKIE = "mx2_session=tok";
const validRuleBody = {
  conditionId: "cond-1",
  tokenId: "tok-1",
  side: "BUY",
  predicates: [
    { kind: "price", source: "ask", comparator: "lte", threshold: 0.5 },
    { kind: "cumulative_notional", source: "ask", priceBound: 0.5, minNotional: 1000 },
    { kind: "visible_levels", source: "ask", priceBound: 0.5, minLevels: 3 },
  ],
  continuousWindowMs: 600_000,
  maxDataAgeMs: 2_000,
  action: { kind: "prepare_order", side: "BUY", price: 0.49, size: 100, orderType: "GTC" },
};

describe("conditional rules routes", () => {
  it("rejects creation when the feature flag is off (fail-closed)", async () => {
    const { app } = buildRulesApp({ conditionalRules: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validRuleBody,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("CONDITIONAL_RULES_DISABLED");
    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = buildRulesApp({});
    const res = await app.inject({ method: "GET", url: "/api/rules" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a rule, audits it, and lists it", async () => {
    const { app, h } = buildRulesApp({});
    const create = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validRuleBody,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().status).toBe("ACTIVE_WAITING");
    expect(create.json().definitionHash).toMatch(/^[0-9a-f]{8}$/);
    expect(h.audits.some((a) => a.action === "rule.created")).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/rules",
      headers: { cookie: COOKIE },
    });
    expect(list.json().rules).toHaveLength(1);
    await app.close();
  });

  it("rejects an invalid predicate threshold", async () => {
    const { app } = buildRulesApp({});
    const res = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {
        ...validRuleBody,
        predicates: [{ kind: "price", source: "ask", comparator: "lte", threshold: 1.5 }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("pauses then cancels a rule; rejects pausing a cancelled rule", async () => {
    const { app } = buildRulesApp({});
    const created = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validRuleBody,
    });
    const id = created.json().id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/rules/${id}/pause`,
          headers: { cookie: COOKIE },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/rules/${id}`, headers: { cookie: COOKIE } }))
        .statusCode,
    ).toBe(200);
    // Already cancelled → invalid state.
    const rePause = await app.inject({
      method: "POST",
      url: `/api/rules/${id}/pause`,
      headers: { cookie: COOKIE },
    });
    expect(rePause.statusCode).toBe(409);
    await app.close();
  });

  it("evaluate-now reports satisfied against a fresh satisfying snapshot", async () => {
    const { app } = buildRulesApp({ snapshotRow: snapshot() });
    const created = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validRuleBody,
    });
    const id = created.json().id as string;
    const res = await app.inject({
      method: "GET",
      url: `/api/rules/${id}/evaluate-now`,
      headers: { cookie: COOKIE },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.hasData).toBe(true);
    expect(body.isStale).toBe(false);
    expect(body.satisfied).toBe(true);
    expect(body.bestAsk).toBe(0.48);
    await app.close();
  });

  it("evaluate-now is not satisfied when the snapshot is stale", async () => {
    const stale = snapshot({ receivedAt: new Date(Date.now() - 60_000) });
    const { app } = buildRulesApp({ snapshotRow: stale });
    const created = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: validRuleBody,
    });
    const id = created.json().id as string;
    const res = await app.inject({
      method: "GET",
      url: `/api/rules/${id}/evaluate-now`,
      headers: { cookie: COOKIE },
    });
    expect(res.json().isStale).toBe(true);
    expect(res.json().satisfied).toBe(false);
    await app.close();
  });

  it("confirms a trigger idempotently and links the order intent", async () => {
    const ruleStore = makeRuleStore();
    // Seed a rule already in TRIGGERED state + a pending trigger.
    const rule = await ruleStore.create({
      walletAddress: WALLET,
      conditionId: "cond-1",
      tokenId: "tok-1",
      side: "BUY",
      definition: {
        ...validRuleBody,
        version: 1,
        outcomeSide: "BUY",
        recurrence: "once",
        expiresAtMs: null,
      } as unknown as RuleDefinition,
      definitionHash: "deadbeef",
      expiresAt: null,
    });
    rule.status = "TRIGGERED_AWAITING_USER";
    const triggerStore = makeTriggerStore([
      {
        id: "trig-1",
        ruleId: rule.id,
        walletAddress: WALLET,
        triggeredAt: new Date(),
        evidence: {},
        reasonCodes: [],
        status: "awaiting_user",
        orderIntentId: null,
        createdAt: new Date(),
      },
    ]);
    const { app } = buildRulesApp({ ruleStore, triggerStore });

    const confirm1 = await app.inject({
      method: "POST",
      url: "/api/rules/triggers/trig-1/confirm",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: { orderIntentId: "intent-9" },
    });
    expect(confirm1.statusCode).toBe(200);
    expect(triggerStore.rows[0]?.status).toBe("confirmed");
    expect(triggerStore.rows[0]?.orderIntentId).toBe("intent-9");
    expect(ruleStore.rows[0]?.status).toBe("EXECUTED_MANUALLY");

    // Second confirm is idempotent.
    const confirm2 = await app.inject({
      method: "POST",
      url: "/api/rules/triggers/trig-1/confirm",
      headers: { "content-type": "application/json", cookie: COOKIE },
      payload: {},
    });
    expect(confirm2.json().idempotent).toBe(true);
    await app.close();
  });
});
