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

// ── Harness (clone of the smart-orders test app with an aiClient) ───────────

const buildAiApp = (opts: {
  aiChat?: boolean;
  responses?: Anthropic.Message[];
  model?: string;
  findMarket?: GammaClient["findMarket"];
}) => {
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const responses = [...(opts.responses ?? [])];
  const aiCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  const aiEnabled = opts.aiChat !== false;
  const config = loadConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    ...(aiEnabled ? { FEATURE_AI_CHAT: "true", ANTHROPIC_API_KEY: "sk-ant-test" } : {}),
    ...(opts.model ? { AI_MODEL: opts.model } : {}),
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
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: opts.findMarket ?? (async () => ok(null)),
    searchMarkets: async () => ok([searchEvent()]),
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
    isAllowed: async () => true,
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
    archive: async () => null,
    unarchive: async () => null,
    addExecutedNotional: async () => {},
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

    // The model must never see real ids: the search tool_result (sent on the
    // 2nd model call) must not contain the tokenId or conditionId.
    const secondCallMessages = JSON.stringify(aiCalls[1]!.messages);
    expect(secondCallMessages).not.toContain(TOKEN_YES);
    expect(secondCallMessages).not.toContain("cond-btc");
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

  it("422s AI_GENERATION_FAILED when the repair round also fails", async () => {
    const bad = createInput({ conditions: [conditionNode(1.5)] });
    const { app } = buildAiApp({
      responses: [
        modelTurn([toolUse("search_markets", { query: "btc" }, "t1")]),
        modelTurn([toolUse("create_strategy", bad, "t2")]),
        modelTurn([toolUse("create_strategy", bad, "t3")]),
      ],
    });
    const res = await post(app, { prompt: "buy the dip on btc please" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "AI_GENERATION_FAILED" });
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
      ],
    });
    const res = await post(app, { prompt: "tweak my strategy to watch that evil token" });
    expect(res.statusCode).toBe(422);
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

  it("terminates a runaway loop after the model-call cap (422)", async () => {
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
    expect(res.statusCode).toBe(422);
    expect(aiCalls.length).toBeLessThanOrEqual(6);
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

  it("502s AI_UPSTREAM when the model call throws", async () => {
    const { app } = buildAiApp({ responses: [] }); // empty queue → fake throws
    const res = await post(app, { prompt: "buy the dip on btc" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "AI_UPSTREAM" });
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
  it("sends output_config.effort on the sonnet default but omits it for haiku", async () => {
    const clarifyTurn = () => modelTurn([toolUse("clarify", { question: "Which market?" }, "t")]);

    const sonnet = buildAiApp({ responses: [clarifyTurn()] });
    await post(sonnet.app, { prompt: "buy the dip on btc" });
    expect(sonnet.aiCalls[0]!.output_config).toEqual({ effort: "medium" });
    await sonnet.app.close();
    resetRateLimits();

    const haiku = buildAiApp({ responses: [clarifyTurn()], model: "claude-haiku-4-5" });
    await post(haiku.app, { prompt: "buy the dip on btc" });
    expect(haiku.aiCalls[0]!.model).toBe("claude-haiku-4-5");
    expect(haiku.aiCalls[0]!.output_config).toBeUndefined();
    await haiku.app.close();
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
