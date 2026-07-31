import { describe, it, expect, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  AllowlistStore,
  ChallengeStore,
  ClobCredentialStore,
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
import type {
  AuthenticatedClobClient,
  ClobClient,
  DataClient,
  GammaClient,
  GammaEvent,
  GammaMarket,
  GeoblockClient,
  PolymarketError,
} from "@mx2/polymarket-client";
import { createMockTradingSigner, type TradingSigner } from "@mx2/trading-signer";
import { buildApp, type DbProbe } from "../app.js";
import { resetRateLimits } from "../middleware/rate-limit.js";
import { resetSmartSearchCache } from "../lib/market-search.js";
import type { AiClient } from "../ai/client.js";

const logger = createLogger({ name: "ai-test", level: "silent" });
const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_YES = "111222333";
const TOKEN_NO = "444555666";

const gammaMarket = (): GammaMarket =>
  ({
    id: "m-1",
    question: "Will BTC hit $150k in 2026?",
    description: "",
    conditionId: "cond-btc",
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
    liquidity: "5000",
    volume: "90000",
    openInterest: "0",
    lastTradePrice: "0.48",
    bestBid: "0.47",
    bestAsk: "0.48",
    spread: "0.01",
    status: "open",
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.48","0.52"]',
    clobTokenIds: `["${TOKEN_YES}","${TOKEN_NO}"]`,
  }) as GammaMarket;

const searchEvent = (): GammaEvent =>
  ({
    id: "ev-1",
    title: "Will BTC hit $150k in 2026?",
    image: "",
    endDate: null,
    markets: [gammaMarket()],
  }) as unknown as GammaEvent;

const toolUse = (name: string, input: unknown, id: string): unknown => ({
  type: "tool_use",
  id,
  name,
  input,
});

const modelTurn = (content: unknown[], stopReason = "tool_use"): Anthropic.Message =>
  ({ content, stop_reason: stopReason }) as unknown as Anthropic.Message;

const selector = (index = 0) => ({ source: "search", index, tokenId: "", outcome: "Yes" });

const conditionNode = (threshold: number) => ({
  type: "condition",
  condition: {
    kind: "price",
    market: selector(),
    source: "ask",
    comparator: "lte",
    threshold,
    priceBound: null,
    minNotional: null,
    minLevels: null,
    startMs: null,
    endMs: null,
  },
});

const createInput = (over: Record<string, unknown> = {}) => ({
  name: "Buy the dip",
  summary: "Buys 100 Yes shares when the price dips below 45¢ for 5 minutes.",
  rootOp: "and",
  conditions: [conditionNode(0.45)],
  holdsForMs: 300_000,
  action: {
    kind: "order",
    market: selector(),
    side: "BUY",
    price: 0.44,
    size: 100,
  },
  recurrence: { kind: "once", maxRepeats: null, cooldownMs: null },
  ...over,
});

/** A valid already-compiled definition, as the builder sends when refining. */
const currentDefinition = () => ({
  version: 2,
  name: "My strategy",
  templateId: null,
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "c1",
        condition: {
          kind: "price",
          market: { conditionId: "cond-btc", tokenId: TOKEN_YES, outcome: "Yes" },
          source: "ask",
          comparator: "lte",
          threshold: 0.45,
        },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 30_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
});

// ── Harness (clone of the smart-orders test app with an aiClient) ───────────

const buildAiApp = (opts: {
  aiChat?: boolean;
  responses?: Anthropic.Message[];
  model?: string;
  webSearch?: boolean;
  findMarket?: GammaClient["findMarket"];
  searchMarkets?: GammaClient["searchMarkets"];
}) => {
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const responses = [...(opts.responses ?? [])];
  const aiCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  const aiEnabled = opts.aiChat !== false;
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...(aiEnabled ? { FEATURE_AI_CHAT: "true", ANTHROPIC_API_KEY: "sk-ant-test" } : {}),
    ...(opts.model ? { AI_MODEL: opts.model } : {}),
    ...(opts.webSearch ? { FEATURE_AI_WEB_SEARCH: "true" } : {}),
  });

  const aiClient: AiClient | null = aiEnabled
    ? {
        create: async (params) => {
          aiCalls.push(params);
          const next = responses.shift();
          if (!next) throw new Error("no scripted model response left");
          return next;
        },
      }
    : null;

  const auditStore: AuditStore = {
    emit: async (e) => {
      audits.push({ action: e.action, metadata: e.metadata });
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
    forSubject: async () => [],
  };

  const gamma: GammaClient = {
    listEvents: async () => ok([]),
    listEventsPaginated: async () =>
      ok({ data: [], pagination: { hasMore: false, totalResults: 0 } }),
    getSeries: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: opts.findMarket ?? (async () => ok(null)),
    getTag: async () => ok(null),
    listRelatedTags: async () => ok([]),
    searchMarkets: opts.searchMarkets ?? (async () => ok([searchEvent()])),
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
    getUserTrades: async () => ok([]),
  };
  const geo: GeoblockClient = {
    check: async (ip) => ok({ status: "allowed", country: "DE", region: null, ip }),
  };

  const sessions: SessionStore = {
    create: async () => {
      throw new Error("no");
    },
    findByTokenHash: async () => null,
    revoke: async () => {},
    revokeAllForWallet: async () => 0,
  };
  const marketSnapshots: MarketSnapshotStore = {
    upsert: async () => {
      throw new Error("no");
    },
    findByTokenId: async () => null,
    markStale: async () => {},
  };
  const users: UserStore = {
    upsert: async (w) => ({ walletAddress: w, createdAt: new Date(), lastSeenAt: new Date() }),
    findByWallet: async () => null,
  };
  const challenges: ChallengeStore = {
    create: async () => {
      throw new Error("no");
    },
    findByNonce: async () => null,
    markUsed: async () => {},
  };
  const allowlist: AllowlistStore = {
    isRevoked: async () => false,
    findEntry: async () => null,
    add: async () => {
      throw new Error("no");
    },
    remove: async () => {},
  };
  const creds: ClobCredentialStore = {
    upsert: async () => {
      throw new Error("no");
    },
    find: async () => null,
    delete: async () => {},
  };
  const intents: OrderIntentStore = {
    create: async () => {
      throw new Error("no");
    },
    findByIdempotencyKey: async () => null,
    releaseIdempotencyKey: async () => true,
    findById: async () => null,
    listByWallet: async () => [],
    updateStatus: async () => {},
    countRecentByWallet: async () => 0,
    sumRuleAutoNotional: async () => 0,
    listForSync: async () => [],
    findByIds: async () => [],
    listByRuleMetadata: async () => [],
    updateFillState: async () => true,
  };
  const flags: RuntimeFlagStore = {
    get: async () => null,
    set: async (k, v, by) => ({ key: k, value: v, updatedBy: by, updatedAt: new Date() }),
  };
  const ruleStore: RuleStore = {
    create: async () => {
      throw new Error("no");
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
    setName: async () => null,
    setStarred: async () => null,
    archive: async () => null,
    unarchive: async () => null,
    addExecutedNotional: async () => {},
    claimSeriesWindow: async () => true,
    listStuckExecuting: async () => [],
    revertExecuting: async () => null,
    createSuperseding: async () => null,
  };
  const triggers: TriggerStore = {
    create: async () => {
      throw new Error("no");
    },
    findById: async () => null,
    findByIdForWallet: async () => null,
    listByWallet: async () => [],
    listAwaiting: async () => [],
    hasForRule: async () => false,
    listByRule: async () => [],
    updateStatus: async () => {},
    scheduleAutoRetry: async () => {},
    clearAutoRetry: async () => {},
    listAutoRetryable: async () => [],
    listAutoRetryLapsed: async () => [],
    markAutoExecuted: async () => {},
    markAutoFailed: async () => {},
    acknowledge: async () => null,
    listUnacknowledgedAutoExecuted: async () => [],
  };
  const privyWallets: PrivyWalletStore = {
    upsert: async () => {
      throw new Error("no");
    },
    find: async () => null,
    markAllowancesBootstrapped: async () => {},
  };
  const delegations: DelegationStore = {
    create: async () => {
      throw new Error("no");
    },
    findActive: async () => null,
    revoke: async () => {},
    expireLapsed: async () => {},
  };
  const signer: TradingSigner = createMockTradingSigner({ privateKey: `0x${"1".repeat(64)}` });

  const app = buildApp({
    config,
    logger,
    db: { ping: async () => true } satisfies DbProbe,
    auditStore,
    marketSnapshots,
    challenges,
    users,
    sessions,
    allowlist,
    clobCredentials: creds,
    orderIntents: intents,
    runtimeFlags: flags,
    ruleStore,
    triggerStore: triggers,
    privyWallets,
    delegations,
    gammaClient: gamma,
    clobClient: clob,
    dataClient: data,
    tradingClobClient: trading,
    tradingSigner: signer,
    geoblockClient: geo,
    aiClient,
  });

  return { app, audits, aiCalls };
};

const post = (app: ReturnType<typeof buildAiApp>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/api/ai/generate-strategy", payload: payload as object });

beforeEach(() => {
  resetRateLimits();
  resetSmartSearchCache();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/ai/generate-strategy", () => {
  it("503s AI_DISABLED when the feature is off", async () => {
    const { app } = buildAiApp({ aiChat: false });
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "AI_DISABLED" });
    await app.close();
  });

  it("400s on a too-short or too-long prompt", async () => {
    const { app } = buildAiApp({ responses: [] });
    expect((await post(app, { prompt: "hi" })).statusCode).toBe(400);
    expect((await post(app, { prompt: "x".repeat(501) })).statusCode).toBe(400);
    await app.close();
  });

  it("happy path: search → create binds a real tokenId, forces prepare, audits", async () => {
    const { app, audits, aiCalls } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc 150k" }, "t1")]),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await post(app, { prompt: "buy yes on btc 150k if it dips below 45 cents" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.definition.version).toBe(2);
    expect(body.definition.templateId).toBe("ai");
    expect(body.definition.action.execution).toBe("prepare");
    expect(body.definition.action.market.tokenId).toBe(TOKEN_YES);
    expect(body.definition.action.market.conditionId).toBe("cond-btc");
    expect(body.definition.expr.children[0].condition.market.tokenId).toBe(TOKEN_YES);
    expect(body.markets[TOKEN_YES].title).toContain("BTC");
    expect(body.summary).toContain("dips");
    // open_questions absent from the tool input → defaults to [].
    expect(body.openQuestions).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("ai.strategy_generated");

    // Fresh prompts are seeded with pre-searched candidates on call 1.
    expect(JSON.stringify(aiCalls[0]!.messages)).toContain("Pre-searched candidates");

    // The model must never see real ids: neither the seeded candidates nor the
    // search tool_result (sent on the 2nd model call) may contain the tokenId
    // or conditionId.
    const secondCallMessages = JSON.stringify(aiCalls[1]!.messages);
    expect(secondCallMessages).not.toContain(TOKEN_YES);
    expect(secondCallMessages).not.toContain("cond-btc");
    await app.close();
  });

  it("converts a dollar budget to shares at the fresh price and surfaces the assumption", async () => {
    const { app } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc 150k" }, "t1")]),
        modelTurn([
          toolUse(
            "create_strategy",
            // "$200 of YES" → budgetUsd, not a 200-share order.
            createInput({
              action: {
                kind: "order",
                market: selector(),
                side: "BUY",
                price: 0.44,
                size: null,
                budgetUsd: 200,
              },
            }),
            "t2",
          ),
        ]),
      ],
    });
    const res = await post(app, { prompt: "buy $200 of yes on btc 150k" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // YES current price 0.48 → 200 / 0.44 (the model's own limit) rounds; the
    // server converts at the ACTION price it will submit at.
    expect(body.definition.action.size).toBe(Math.round(200 / 0.44));
    expect(body.definition.action.size).not.toBe(200); // never a silent 200 shares
    expect(
      (body.warnings as string[]).some((w) => w.includes("$200") && w.includes("shares")),
    ).toBe(true);
    await app.close();
  });

  it("anchors a missing order price to the candidate's current price (never 0)", async () => {
    const { app } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc 150k" }, "t1")]),
        modelTurn([
          toolUse(
            "create_strategy",
            createInput({
              action: { kind: "order", market: selector(), side: "BUY", price: null, size: 50 },
            }),
            "t2",
          ),
        ]),
      ],
    });
    const res = await post(app, { prompt: "buy yes on btc 150k" });
    const body = res.json();
    // Anchored to YES current price 0.48, not the old `?? 0` fallback.
    expect(body.definition.action.price).toBe(0.48);
    await app.close();
  });

  it("passes open_questions through with the draft, clamped to 3 items", async () => {
    const { app } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc 150k" }, "t1")]),
        modelTurn([
          toolUse(
            "create_strategy",
            createInput({
              open_questions: [
                "Assumed a $100 stake — how much do you want to trade?",
                "Assumed the December market — did you mean another date?",
                "Alert only for now — want a prepared order instead?",
                "A fourth question that must be dropped",
              ],
            }),
            "t2",
          ),
        ]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc 150k" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.openQuestions).toHaveLength(3);
    expect(body.openQuestions[0]).toContain("$100 stake");
    await app.close();
  });

  it("repairs once on validation issues, then succeeds", async () => {
    const { app, aiCalls } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc" }, "t1")]),
        modelTurn([
          toolUse("create_strategy", createInput({ conditions: [conditionNode(1.5)] }), "t2"),
        ]),
        modelTurn([toolUse("create_strategy", createInput(), "t3")]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc please" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(aiCalls).toHaveLength(3);
    // The repair round told the model what was wrong.
    expect(JSON.stringify(aiCalls[2]!.messages)).toContain("PRICE_OUT_OF_RANGE");
    await app.close();
  });

  it("falls back to a guaranteed minimal draft when both repair rounds fail", async () => {
    const bad = createInput({ conditions: [conditionNode(1.5)] });
    const { app, audits } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc" }, "t1")]),
        modelTurn([toolUse("create_strategy", bad, "t2")]),
        modelTurn([toolUse("create_strategy", bad, "t3")]),
        modelTurn([toolUse("create_strategy", bad, "t4")]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc please" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.fallback).toBe(true);
    // Minimal alert anchored to the verified candidate's current YES price.
    expect(body.definition.action).toEqual({ kind: "alert" });
    expect(body.definition.expr.children).toHaveLength(1);
    expect(body.definition.expr.children[0].condition.threshold).toBe(0.48);
    expect(body.definition.expr.children[0].condition.market.tokenId).toBe(TOKEN_YES);
    expect((body.warnings as string[])[0]).toContain("minimal draft");
    expect(body.openQuestions.length).toBeGreaterThan(0);
    const audit = audits.find((a) => a.action === "ai.strategy_generated");
    expect(audit?.metadata.fallback).toBe(true);
    await app.close();
  });

  it("rejects fabricated source:current tokenIds (model cannot invent ids)", async () => {
    const fabricated = createInput({
      conditions: [
        {
          ...conditionNode(0.45),
          condition: {
            ...conditionNode(0.45).condition,
            market: { source: "current", index: 0, tokenId: "evil-token", outcome: "Yes" },
          },
        },
      ],
      action: { kind: "alert", market: null, side: "BUY", price: null, size: null },
    });
    const { app } = buildAiApp({
      responses: [
        modelTurn([toolUse("create_strategy", fabricated, "t1")]),
        modelTurn([toolUse("create_strategy", fabricated, "t2")]),
        modelTurn([toolUse("create_strategy", fabricated, "t3")]),
      ],
    });
    const res = await post(app, { prompt: "tweak my strategy to watch that evil token" });
    // The fabricated id never binds; the guaranteed draft binds the VERIFIED
    // seeded candidate instead.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.fallback).toBe(true);
    expect(JSON.stringify(body.definition)).not.toContain("evil-token");
    expect(body.definition.expr.children[0].condition.market.tokenId).toBe(TOKEN_YES);
    await app.close();
  });

  it("serves get_market_stats from verified candidates and enforces the cap", async () => {
    const statsCall = (id: string, index = 0) =>
      toolUse("get_market_stats", { index, outcome: "Yes" }, id);
    const { app, aiCalls } = buildAiApp({
      responses: [
        // 4 stats calls in one turn: 3 served, the 4th refused with STATS_LIMIT.
        modelTurn([statsCall("s1"), statsCall("s2"), statsCall("s3"), statsCall("s4")]),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc if it looks calm" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    const secondCall = JSON.stringify(aiCalls[1]!.messages);
    // Served payload sections (book from the search snapshot even when CLOB
    // history/economics upstreams fail) …
    expect(secondCall).toContain('\\"book\\"');
    expect(secondCall).toContain('\\"bestAsk\\":0.48');
    expect(secondCall).toContain('\\"activity\\"');
    // … and the 4th call hit the per-request cap.
    expect(secondCall).toContain("STATS_LIMIT");
    // Ids stay withheld from the model even via stats payloads.
    expect(secondCall).not.toContain(TOKEN_YES);
    expect(secondCall).not.toContain("cond-btc");
    await app.close();
  });

  it("rejects get_market_stats for an unknown candidate index", async () => {
    const { app, aiCalls } = buildAiApp({
      responses: [
        modelTurn([toolUse("get_market_stats", { index: 99, outcome: "Yes" }, "s1")]),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(aiCalls[1]!.messages)).toContain("UNKNOWN_MARKET");
    await app.close();
  });

  it("answers product questions via answer_user on the clarify wire shape", async () => {
    const { app, aiCalls } = buildAiApp({
      responses: [
        modelTurn([
          toolUse(
            "answer_user",
            { answer: "Your personal referral code lives on your **Profile** page." },
            "t1",
          ),
        ]),
      ],
    });
    const res = await post(app, { prompt: "how do I issue a ref code?" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "clarify",
      question: "Your personal referral code lives on your **Profile** page.",
    });
    // The product guide is part of the cached system block the model saw.
    const system = aiCalls[0]!.system as { text: string }[];
    expect(system[0]!.text).toContain("Product guide");
    await app.close();
  });

  it("passes clarify questions through", async () => {
    const { app } = buildAiApp({
      responses: [modelTurn([toolUse("clarify", { question: "Which market do you mean?" }, "t1")])],
    });
    const res = await post(app, { prompt: "buy the thing" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "clarify", question: "Which market do you mean?" });
    await app.close();
  });

  it("treats a text-only end turn as a clarification", async () => {
    const { app } = buildAiApp({
      responses: [modelTurn([{ type: "text", text: "Could you name the market?" }], "end_turn")],
    });
    const res = await post(app, { prompt: "do something clever" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("clarify");
    expect(res.json().question).toContain("name the market");
    await app.close();
  });

  it("terminates a runaway loop at the seeded call cap and still returns a draft", async () => {
    const searchTurn = () => modelTurn([toolUse("search_markets", { query: "btc" }, "t")]);
    const { app, aiCalls } = buildAiApp({
      responses: [
        searchTurn(),
        searchTurn(),
        searchTurn(),
        searchTurn(),
        searchTurn(),
        searchTurn(),
      ],
    });
    const res = await post(app, { prompt: "keep searching forever" });
    // Budget exhausted → guaranteed draft from the seeded candidate, and the
    // seeded cap (5) kicked in below the absolute cap (6).
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().fallback).toBe(true);
    expect(aiCalls.length).toBeLessThanOrEqual(5);
    await app.close();
  });

  it("rate-limits the burst window (6th call in a minute is 429, no model spend)", async () => {
    const clarifyTurn = () => modelTurn([toolUse("clarify", { question: "Which market?" }, "t")]);
    const { app, aiCalls } = buildAiApp({
      responses: [clarifyTurn(), clarifyTurn(), clarifyTurn(), clarifyTurn(), clarifyTurn()],
    });
    for (let i = 0; i < 5; i++) {
      const okRes = await post(app, { prompt: "buy the dip on btc" });
      expect(okRes.statusCode).toBe(200);
    }
    const limited = await post(app, { prompt: "buy the dip on btc" });
    expect(limited.statusCode).toBe(429);
    expect(aiCalls).toHaveLength(5);
    await app.close();
  });

  it("model outage after seeding still yields a guaranteed draft", async () => {
    const { app } = buildAiApp({ responses: [] }); // empty queue → fake throws
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().fallback).toBe(true);
    await app.close();
  });

  it("502s AI_UPSTREAM when the model throws and no candidates exist", async () => {
    const { app } = buildAiApp({
      responses: [], // empty queue → fake throws on call 1
      searchMarkets: async () => err(upstreamErr), // seeding finds nothing
    });
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "AI_UPSTREAM" });
    await app.close();
  });

  it("refinement failure clarifies instead of clobbering the user's strategy", async () => {
    const bad = createInput({ conditions: [conditionNode(1.5)] });
    const { app, aiCalls } = buildAiApp({
      responses: [
        modelTurn([toolUse("create_strategy", bad, "t1")]),
        modelTurn([toolUse("create_strategy", bad, "t2")]),
        modelTurn([toolUse("create_strategy", bad, "t3")]),
      ],
    });
    const res = await post(app, {
      prompt: "make the threshold way higher please",
      history: [{ role: "user", content: "buy the dip on btc" }],
      currentDefinition: currentDefinition(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("clarify");
    expect(body.question).toContain("couldn't apply that change");
    // Refinement turns are never seeded.
    expect(JSON.stringify(aiCalls[0]!.messages)).not.toContain("Pre-searched candidates");
    await app.close();
  });

  it("clarifies when no live market can be found at all", async () => {
    const ref = () => modelTurn([toolUse("create_strategy", createInput(), "t")]);
    const { app } = buildAiApp({
      responses: [ref(), ref(), ref()], // index 0 never resolves — no candidates
      searchMarkets: async () => err(upstreamErr),
    });
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("clarify");
    expect(res.json().question).toContain("couldn't find a live market");
    await app.close();
  });

  it("pinned markets: generates with NO search turn, ids still withheld from the model", async () => {
    const { app, aiCalls } = buildAiApp({
      findMarket: async () => ok(gammaMarket()),
      responses: [modelTurn([toolUse("create_strategy", createInput(), "t1")])],
    });
    const res = await post(app, {
      prompt: "buy the dip on the pinned market",
      pinnedConditionIds: ["cond-btc-000000"],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    // Bound from the pinned candidate — one model call, zero search turns.
    expect(body.definition.action.market.tokenId).toBe(TOKEN_YES);
    expect(aiCalls).toHaveLength(1);
    const firstMessages = JSON.stringify(aiCalls[0]!.messages);
    expect(firstMessages).toContain("Pinned markets");
    expect(firstMessages).not.toContain(TOKEN_YES);
    expect(firstMessages).not.toContain("cond-btc");
    await app.close();
  });

  it("drops unresolvable pinned ids and falls back to search", async () => {
    const { app, aiCalls } = buildAiApp({
      findMarket: async () => ok(null),
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc" }, "t1")]),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await post(app, {
      prompt: "buy the dip on btc please",
      pinnedConditionIds: ["cond-does-not-exist"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(JSON.stringify(aiCalls[0]!.messages)).not.toContain("Pinned markets");
    await app.close();
  });

  // Haiku-tier models reject `effort` with a 400 — the loop must gate it.
  it("omits output_config.effort on the haiku default but sends it for sonnet", async () => {
    const clarifyTurn = () => modelTurn([toolUse("clarify", { question: "Which market?" }, "t")]);

    const haiku = buildAiApp({ responses: [clarifyTurn()] });
    await post(haiku.app, { prompt: "buy the dip on btc" });
    expect(haiku.aiCalls[0]!.model).toBe("claude-haiku-4-5"); // config default
    expect(haiku.aiCalls[0]!.output_config).toBeUndefined();
    await haiku.app.close();
    resetRateLimits();

    const sonnet = buildAiApp({ responses: [clarifyTurn()], model: "claude-sonnet-5" });
    await post(sonnet.app, { prompt: "buy the dip on btc" });
    expect(sonnet.aiCalls[0]!.output_config).toEqual({ effort: "medium" });
    await sonnet.app.close();
  });

  it("appends the hosted web_search tool only when the flag is on, versioned by model", async () => {
    const clarifyTurn = () => modelTurn([toolUse("clarify", { question: "Which market?" }, "t")]);
    const toolNames = (calls: Anthropic.MessageCreateParamsNonStreaming[]) =>
      (calls[0]!.tools ?? []).map((t) => ("name" in t ? t.name : ""));

    const off = buildAiApp({ responses: [clarifyTurn()] });
    await post(off.app, { prompt: "buy the dip on btc" });
    expect(toolNames(off.aiCalls)).not.toContain("web_search");
    await off.app.close();
    resetRateLimits();

    // Haiku (the default) gets the basic tool version.
    const haiku = buildAiApp({ responses: [clarifyTurn()], webSearch: true });
    await post(haiku.app, { prompt: "buy the dip on btc" });
    const haikuTool = haiku.aiCalls[0]!.tools!.find((t) => "name" in t && t.name === "web_search");
    expect((haikuTool as { type?: string }).type).toBe("web_search_20250305");
    await haiku.app.close();
    resetRateLimits();

    // Sonnet-tier gets the dynamic-filtering version.
    const sonnet = buildAiApp({
      responses: [clarifyTurn()],
      webSearch: true,
      model: "claude-sonnet-5",
    });
    await post(sonnet.app, { prompt: "buy the dip on btc" });
    const sonnetTool = sonnet.aiCalls[0]!.tools!.find(
      (t) => "name" in t && t.name === "web_search",
    );
    expect((sonnetTool as { type?: string }).type).toBe("web_search_20260209");
    await sonnet.app.close();
  });

  it("resumes pause_turn server-tool rounds and surfaces web citations", async () => {
    const webBlocks = [
      { type: "server_tool_use", id: "st1", name: "web_search", input: { query: "fed meeting" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "st1",
        content: [
          { type: "web_search_result", url: "https://example.com/fed", title: "Fed schedule" },
          { type: "web_search_result", url: "https://example.com/fed", title: "duplicate" },
        ],
      },
    ];
    const { app, aiCalls } = buildAiApp({
      webSearch: true,
      responses: [
        modelTurn(webBlocks, "pause_turn"),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await post(app, { prompt: "buy yes on the fed cutting rates" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.sources).toEqual([{ url: "https://example.com/fed", title: "Fed schedule" }]);
    // pause_turn was resumed by echoing the assistant turn — no repair burned.
    expect(aiCalls).toHaveLength(2);
    const echoed = aiCalls[1]!.messages.at(-1);
    expect(echoed?.role).toBe("assistant");
    await app.close();
  });

  it("skips error-shaped web_search results without failing the draft", async () => {
    const { app } = buildAiApp({
      webSearch: true,
      responses: [
        modelTurn([
          {
            type: "web_search_tool_result",
            tool_use_id: "st1",
            content: { error_code: "max_uses_exceeded" },
          },
          toolUse("create_strategy", createInput(), "t1"),
        ]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().sources).toBeUndefined();
    await app.close();
  });

  // The cache mark must sit on a byte-stable block: the volatile time line
  // rides a SECOND system block, after the cached prefix.
  it("keeps the timestamp out of the cached system block", async () => {
    const { app, aiCalls } = buildAiApp({
      responses: [modelTurn([toolUse("clarify", { question: "Which market?" }, "t")])],
    });
    await post(app, { prompt: "buy the dip on btc" });
    const system = aiCalls[0]!.system as {
      text: string;
      cache_control?: { type: string };
    }[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).not.toContain("Current time");
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[1]!.text).toContain("Current time");
    await app.close();
  });
});

describe("POST /api/ai/generate-strategy/stream (SSE)", () => {
  const parseSse = (payload: string) =>
    payload
      .split("\n\n")
      .filter((f) => f.trim().length > 0 && !f.startsWith(":"))
      .map((f) => {
        const ev = /event: (\S+)/.exec(f)?.[1] ?? "message";
        const data = /data: (.*)/.exec(f)?.[1];
        return { ev, data: data ? (JSON.parse(data) as Record<string, unknown>) : null };
      });

  it("streams real stage events and a terminal result", async () => {
    const { app, audits } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc 150k" }, "t1")]),
        modelTurn([toolUse("create_strategy", createInput(), "t2")]),
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/generate-strategy/stream",
      payload: { prompt: "buy yes on btc 150k if it dips below 45 cents" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    const stages = events.filter((e) => e.ev === "stage").map((e) => e.data?.stage);
    expect(stages).toContain("searching");
    expect(stages).toContain("drafting");

    const result = events.find((e) => e.ev === "result");
    expect(result?.data?.status).toBe("ok");
    const definition = result?.data?.definition as { action: { market: { tokenId: string } } };
    expect(definition.action.market.tokenId).toBe(TOKEN_YES);
    // Audit fires exactly like the JSON route.
    expect(audits.map((a) => a.action)).toContain("ai.strategy_generated");
    await app.close();
  });

  it("400s invalid bodies as plain JSON before hijacking", async () => {
    const { app } = buildAiApp({ responses: [] });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/generate-strategy/stream",
      payload: { prompt: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_REQUEST" });
    await app.close();
  });

  it("shares the burst rate-limit budget with the JSON route", async () => {
    const clarifyTurn = () => modelTurn([toolUse("clarify", { question: "Which market?" }, "t")]);
    const { app } = buildAiApp({
      responses: [clarifyTurn(), clarifyTurn(), clarifyTurn(), clarifyTurn(), clarifyTurn()],
    });
    for (let i = 0; i < 5; i++) {
      expect((await post(app, { prompt: "buy the dip on btc" })).statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/ai/generate-strategy/stream",
      payload: { prompt: "buy the dip on btc" },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});

// ── Few-shot sync guarantee ──────────────────────────────────────────────────
// The system prompt's examples come from the canonical template specs; every
// one must parse under the SAME zod mirror the live tool loop applies, so a
// spec edit can never teach the model an invalid create_strategy shape.
describe("template few-shots", () => {
  it("every TEMPLATE_SPECS aiFewShot parses under CreateStrategyInputZ", async () => {
    const { TEMPLATE_SPECS } = await import("@mx2/rules");
    const { CreateStrategyInputZ } = await import("../ai/tools.js");
    for (const spec of TEMPLATE_SPECS) {
      if (!spec.aiFewShot) continue;
      const parsed = CreateStrategyInputZ.safeParse(JSON.parse(spec.aiFewShot.json));
      expect(parsed.success, `${spec.id}: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(true);
    }
  });
});
