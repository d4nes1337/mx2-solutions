import type Anthropic from "@anthropic-ai/sdk";
import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import {
  validateStrategyDefinition,
  type ActionV2,
  type ConditionV2,
  type ExprNode,
  type MarketRef,
  type RecurrenceV2,
  type StrategyDefinition,
} from "@mx2/rules";
import {
  hitFromGammaMarket,
  smartSearchMarketHits,
  type MarketSearchHit,
} from "../lib/market-search.js";
import type { AiClient } from "./client.js";
import { STABLE_SYSTEM_PROMPT, timeBlock } from "./prompt.js";
import {
  ANSWER_TOOL,
  AnswerInputZ,
  CLARIFY_TOOL,
  CREATE_STRATEGY_TOOL,
  ClarifyInputZ,
  CreateStrategyInputZ,
  GET_MARKET_STATS_TOOL,
  GetMarketStatsInputZ,
  SEARCH_MARKETS_TOOL,
  SearchMarketsInputZ,
  type AiCondition,
  type AiMarketSelector,
  type CreateStrategyInput,
} from "./tools.js";
import { buildMarketStats } from "./stats.js";

// Hard loop caps: a paid upstream on a public endpoint must be bounded.
const MAX_MODEL_CALLS = 6;
/** When we pre-searched for the model, the happy path is 1 call — cap lower. */
const MAX_MODEL_CALLS_SEEDED = 5;
const MAX_SEARCHES = 4;
const MAX_STATS_CALLS = 3;
const MAX_REPAIR_ROUNDS = 2;
const SEARCH_HITS_PER_QUERY = 8;
const SEARCH_FAN_OUT = 2;

/** Minimal logging surface (satisfied by both pino and Fastify's req.log). */
export interface GenerateLogger {
  warn(obj: unknown, msg?: string): void;
}

/** Real progress phases surfaced to the SSE route (transport-agnostic). */
export type GenerateStage = "searching" | "drafting" | "analyzing" | "researching" | "repairing";

/** Thrown when the caller's AbortSignal fires (client disconnected). */
export class GenerateAborted extends Error {
  constructor() {
    super("generation aborted by the caller");
    this.name = "GenerateAborted";
  }
}

export interface GenerateDeps {
  aiClient: AiClient;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  logger: GenerateLogger;
  model: string;
  /** Adds Anthropic's hosted web_search tool (FEATURE_AI_WEB_SEARCH). */
  webSearch?: boolean;
  /** Set when pointed at an Anthropic-COMPATIBLE endpoint (Kimi experiment) —
   *  Anthropic-only request params (effort) are omitted then. */
  baseUrl?: string;
  /** Real-progress callback; absent on the plain JSON route. */
  onStage?: (stage: GenerateStage, detail?: string) => void;
  /** Cooperative cancellation — checked between model calls and tool work. */
  signal?: AbortSignal;
  nowMs?: number;
}

export interface GenerateHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  prompt: string;
  /** Compact prior turns (client-held; ≤6 entries). */
  history: GenerateHistoryEntry[];
  /** The builder's current definition when iterating, else null. */
  currentDefinition: StrategyDefinition | null;
  /** Markets the user @-pinned in the panel (resolved server-side; ≤4). */
  pinnedConditionIds?: string[];
}

export interface GeneratedMarketMeta {
  title: string;
  eventTitle?: string;
  image?: string;
  outcome: string;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
}

export type GenerateResult =
  | {
      status: "ok";
      definition: StrategyDefinition;
      summary: string;
      warnings: string[];
      /** Assumptions/quick questions the model wants shown WITH the draft. */
      openQuestions: string[];
      /** Display metadata for every bound market, keyed by tokenId. */
      markets: Record<string, GeneratedMarketMeta>;
      modelCalls: number;
      /** Tool-usage counters (audit only — the route strips them). */
      statsCalls?: number;
      webSearches?: number;
      /** True when this is the deterministic guaranteed-draft floor. */
      fallback?: boolean;
      /** Web pages the model consulted (hosted web_search citations). */
      sources?: { url: string; title: string }[];
    }
  | {
      status: "clarify";
      question: string;
      sources?: { url: string; title: string }[];
    }
  | { status: "error"; code: "AI_UPSTREAM" | "AI_GENERATION_FAILED"; message: string };

// ── Candidate presentation (what the model is allowed to see) ───────────────

/** Search results as shown to the model: indexed, WITHOUT conditionId/tokenIds. */
const presentHits = (hits: MarketSearchHit[], baseIndex: number) =>
  hits.map((h, i) => ({
    index: baseIndex + i,
    title: h.title.slice(0, 120),
    eventTitle: h.eventTitle.slice(0, 120),
    outcomes: h.outcomes,
    outcomePrices: h.outcomePrices.map((p) => Number(p)),
    liquidity: h.liquidity,
    volume: h.volume,
    endDate: h.endDate,
    rewardsMinSize: h.rewardsMinSize,
    rewardsMaxSpread: h.rewardsMaxSpread,
  }));

// ── Mapping the model's flattened output onto the real DSL ──────────────────

interface MappingIssue {
  code: string;
  message: string;
}

class MappingError extends Error {
  issues: MappingIssue[];
  constructor(issues: MappingIssue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.issues = issues;
  }
}

/** Every market ref reachable from a definition (conditions + order action). */
const refsOfDefinition = (def: StrategyDefinition): MarketRef[] => {
  const out: MarketRef[] = [];
  const walk = (node: ExprNode): void => {
    if (node.type === "condition") {
      if (node.condition.kind !== "time_window" && node.condition.market.tokenId !== "") {
        out.push(node.condition.market);
      }
      return;
    }
    node.children.forEach(walk);
  };
  walk(def.expr);
  if (def.action.kind === "order" && def.action.market.tokenId !== "") out.push(def.action.market);
  return out;
};

const resolveSelector = (
  sel: AiMarketSelector,
  candidates: MarketSearchHit[],
  currentRefs: MarketRef[],
): { ref: MarketRef; hit: MarketSearchHit | null } => {
  if (sel.source === "current") {
    const existing = currentRefs.find((r) => r.tokenId === sel.tokenId);
    if (!existing) {
      throw new MappingError([
        {
          code: "UNKNOWN_MARKET",
          message: `source:"current" tokenId ${sel.tokenId.slice(0, 12)}… is not in the current definition — use a search_markets candidate instead.`,
        },
      ]);
    }
    return { ref: existing, hit: null };
  }

  const hit = candidates[sel.index];
  if (!hit) {
    throw new MappingError([
      {
        code: "UNKNOWN_MARKET",
        message: `search index ${sel.index} does not exist — only indexes returned by search_markets are valid.`,
      },
    ]);
  }
  let pos = hit.outcomes.findIndex((o) => o.toLowerCase() === sel.outcome.toLowerCase());
  if (pos === -1) pos = 0;
  const tokenId = hit.tokenIds[pos];
  if (!tokenId) {
    throw new MappingError([
      {
        code: "UNKNOWN_MARKET",
        message: `candidate ${sel.index} has no token for outcome "${sel.outcome}".`,
      },
    ]);
  }
  return {
    ref: {
      conditionId: hit.conditionId,
      tokenId,
      outcome: hit.outcomes[pos] ?? sel.outcome,
      title: hit.title,
    },
    hit,
  };
};

const mapCondition = (
  c: AiCondition,
  resolve: (sel: AiMarketSelector) => MarketRef,
): ConditionV2 => {
  const need = (v: number | null, field: string): number => {
    if (v === null) {
      throw new MappingError([
        { code: "MISSING_FIELD", message: `${c.kind} condition requires ${field}.` },
      ]);
    }
    return v;
  };
  const market = (): MarketRef => {
    if (!c.market) {
      throw new MappingError([
        { code: "MISSING_FIELD", message: `${c.kind} condition requires a market.` },
      ]);
    }
    return resolve(c.market);
  };
  switch (c.kind) {
    case "price":
      return {
        kind: "price",
        market: market(),
        source: c.source,
        comparator: c.comparator,
        threshold: need(c.threshold, "threshold"),
      };
    case "spread":
      return {
        kind: "spread",
        market: market(),
        comparator: c.comparator,
        threshold: need(c.threshold, "threshold"),
      };
    case "cumulative_notional":
      return {
        kind: "cumulative_notional",
        market: market(),
        source: c.source,
        priceBound: need(c.priceBound, "priceBound"),
        minNotional: need(c.minNotional, "minNotional"),
      };
    case "visible_levels":
      return {
        kind: "visible_levels",
        market: market(),
        source: c.source,
        priceBound: need(c.priceBound, "priceBound"),
        minLevels: need(c.minLevels, "minLevels"),
      };
    case "time_window":
      return { kind: "time_window", startMs: c.startMs, endMs: c.endMs };
    case "price_move":
      return {
        kind: "price_move",
        market: market(),
        direction: c.direction ?? "either",
        deltaThreshold: need(c.deltaThreshold, "deltaThreshold"),
        windowMs: need(c.windowMs, "windowMs"),
      };
    case "trailing": {
      const mode = c.mode;
      if (mode === null) {
        throw new MappingError([
          { code: "MISSING_FIELD", message: "trailing condition requires mode (stop|entry)." },
        ]);
      }
      return {
        kind: "trailing",
        market: market(),
        mode,
        source: c.source,
        offset: need(c.offset, "offset"),
      };
    }
  }
};

const buildDefinition = (
  input: CreateStrategyInput,
  candidates: MarketSearchHit[],
  currentDefinition: StrategyDefinition | null,
): {
  definition: StrategyDefinition;
  markets: Record<string, GeneratedMarketMeta>;
  warnings: string[];
} => {
  const currentRefs = currentDefinition ? refsOfDefinition(currentDefinition) : [];
  const markets: Record<string, GeneratedMarketMeta> = {};
  const warnings: string[] = [];

  const resolve = (sel: AiMarketSelector): MarketRef => {
    const { ref, hit } = resolveSelector(sel, candidates, currentRefs);
    if (!markets[ref.tokenId]) {
      markets[ref.tokenId] = hit
        ? {
            title: hit.title,
            eventTitle: hit.eventTitle,
            image: hit.image,
            outcome: ref.outcome,
            rewardsMinSize: hit.rewardsMinSize,
            rewardsMaxSpread: hit.rewardsMaxSpread,
          }
        : {
            title: ref.title ?? "Bound market",
            outcome: ref.outcome,
            rewardsMinSize: null,
            rewardsMaxSpread: null,
          };
    }
    return ref;
  };

  let nodeSeq = 0;
  const nextId = (prefix: string) => `${prefix}${++nodeSeq}`;

  const children: ExprNode[] = input.conditions.map((node) => {
    if (node.type === "condition") {
      return {
        type: "condition",
        id: nextId("c"),
        condition: mapCondition(node.condition, resolve),
      };
    }
    return {
      type: "group",
      id: nextId("g"),
      op: node.op,
      children: node.children.map((child) => ({
        type: "condition" as const,
        id: nextId("c"),
        condition: mapCondition(child.condition, resolve),
      })),
    };
  });

  // Action — execution is ALWAYS "prepare" (unattended trading is a separate,
  // fail-closed feature the AI can never enable). orderType is always GTC.
  let action: ActionV2;
  if (input.action.kind === "order") {
    if (!input.action.market) {
      throw new MappingError([
        { code: "MISSING_FIELD", message: "order action requires a market." },
      ]);
    }
    const marketRef = resolve(input.action.market);
    // Current price for this outcome, from the verified candidate (fresh from
    // the last search). Used to anchor a missing limit price and to convert a
    // dollar budget to shares — never a static, unrelated default (brief §8.1.1/5).
    const hit = candidates.find((h) => h.tokenIds.includes(marketRef.tokenId));
    const currentPrice = hit
      ? Number(hit.outcomePrices[hit.tokenIds.indexOf(marketRef.tokenId)])
      : NaN;
    const clampPrice = (p: number) => Math.min(0.99, Math.max(0.01, Math.round(p * 100) / 100));

    let price: number;
    if (input.action.price !== null && Number.isFinite(input.action.price)) {
      price = clampPrice(input.action.price);
    } else if (Number.isFinite(currentPrice)) {
      price = clampPrice(currentPrice);
    } else {
      price = 0.5;
      warnings.push("No fresh price for this market — defaulted the limit to 50¢; adjust it.");
    }

    // Dollars → shares at the fresh price (brief §8.1.1). A budget must NEVER
    // silently become a share count; the assumption is surfaced with the draft.
    let size: number;
    if (input.action.budgetUsd !== null && Number.isFinite(input.action.budgetUsd)) {
      size = Math.max(1, Math.round(input.action.budgetUsd / price));
      warnings.push(
        `Interpreted $${input.action.budgetUsd} as ${size} shares at ${Math.round(price * 100)}¢ — edit the size if you meant a share count.`,
      );
    } else {
      size = input.action.size ?? 100;
    }

    action = {
      kind: "order",
      market: marketRef,
      side: input.action.side,
      price,
      size,
      orderType: "GTC",
      execution: "prepare",
    };
  } else {
    action = { kind: "alert" };
  }

  // Recurrence — repeat is only valid for alert (or auto, which we never emit);
  // coerce instead of burning the repair round on a known constraint.
  let recurrence: RecurrenceV2;
  if (input.recurrence.kind === "repeat") {
    if (action.kind === "order") {
      recurrence = { kind: "once" };
      warnings.push(
        "Repeat triggers need auto mode (not enabled) — saved as a one-shot strategy instead.",
      );
    } else {
      recurrence = {
        kind: "repeat",
        maxRepeats: Math.min(Math.max(input.recurrence.maxRepeats ?? 5, 2), 100),
        cooldownMs: Math.min(Math.max(input.recurrence.cooldownMs ?? 300_000, 0), 86_400_000),
      };
    }
  } else {
    recurrence = { kind: "once" };
  }

  const definition: StrategyDefinition = {
    version: 2,
    name: (input.name.trim() || "AI strategy").slice(0, 120),
    templateId: "ai",
    expr: { type: "group", id: "root", op: input.rootOp, children },
    holdsForMs: Math.min(Math.max(Math.round(input.holdsForMs), 0), 86_400_000),
    maxDataAgeMs: 5_000,
    action,
    recurrence,
    limits: null,
    expiresAtMs: null,
  };

  // Soft sanity note: an order priced far from the market reads like a typo.
  if (action.kind === "order") {
    const hit = candidates.find((h) => h.tokenIds.includes(action.market.tokenId));
    if (hit) {
      const pos = hit.tokenIds.indexOf(action.market.tokenId);
      const current = Number(hit.outcomePrices[pos]);
      if (Number.isFinite(current) && Math.abs(current - action.price) > 0.2) {
        warnings.push(
          `Heads up: your order price (${Math.round(action.price * 100)}¢) is far from the current price (${Math.round(current * 100)}¢).`,
        );
      }
    }
  }

  return { definition, markets, warnings };
};

// ── Guaranteed-draft fallback ────────────────────────────────────────────────

/**
 * Deterministic floor for fresh generations: when the model cannot produce a
 * valid strategy (repair budget spent, loop exhausted, upstream outage) but we
 * hold at least one VERIFIED candidate, return the minimum useful draft — an
 * alert on the top-ranked candidate anchored at its current price — instead of
 * an error. Refinement turns must never take this path: replacing the user's
 * existing strategy with a minimal alert would destroy their work.
 */
export const buildFallbackDraft = (
  candidates: MarketSearchHit[],
  nowMs: number,
  modelCalls: number,
): Extract<GenerateResult, { status: "ok" }> | null => {
  const hit = candidates[0];
  if (!hit) return null;
  let pos = hit.outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (pos === -1) pos = 0;
  const tokenId = hit.tokenIds[pos];
  const outcome = hit.outcomes[pos];
  if (!tokenId || !outcome) return null;
  const current = Number(hit.outcomePrices[pos]);
  if (!Number.isFinite(current)) return null;
  const threshold = Math.min(0.99, Math.max(0.01, Math.round(current * 100) / 100));

  const definition: StrategyDefinition = {
    version: 2,
    name: `${hit.title.slice(0, 100)} alert`,
    templateId: "ai",
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
            market: { conditionId: hit.conditionId, tokenId, outcome, title: hit.title },
            source: "ask",
            comparator: "lte",
            threshold,
          },
        },
      ],
    },
    holdsForMs: 300_000,
    maxDataAgeMs: 5_000,
    action: { kind: "alert" },
    recurrence: { kind: "once" },
    limits: null,
    expiresAtMs: null,
  };
  if (validateStrategyDefinition(definition, nowMs).length > 0) return null;

  const cents = Math.round(threshold * 100);
  return {
    status: "ok",
    definition,
    summary: `I couldn't finish exactly what you described, so here's a starting point: an alert on “${hit.title}” (${outcome}) when the ask is at or below ${cents}¢ (its current price).`,
    warnings: ["This is a minimal draft — I anchored it to the closest liquid market I found."],
    openQuestions: ["Is this the market you meant? Tell me more and I'll refine it."],
    markets: {
      [tokenId]: {
        title: hit.title,
        eventTitle: hit.eventTitle,
        image: hit.image,
        outcome,
        rewardsMinSize: hit.rewardsMinSize,
        rewardsMaxSpread: hit.rewardsMaxSpread,
      },
    },
    modelCalls,
    fallback: true,
  };
};

// ── The generation loop ──────────────────────────────────────────────────────

const BASE_TOOLS = [
  SEARCH_MARKETS_TOOL,
  GET_MARKET_STATS_TOOL,
  CREATE_STRATEGY_TOOL,
  CLARIFY_TOOL,
  ANSWER_TOOL,
] as unknown as Anthropic.Tool[];

const MAX_WEB_SEARCHES = 3;
const MAX_SOURCES = 5;

/**
 * Tool list per configuration. Deterministic per (webSearch, model) pair so
 * the rendered tools stay byte-stable per process — a flag flip is a
 * deploy-time prompt-cache invalidation, which is acceptable.
 */
const buildTools = (opts: { webSearch: boolean; model: string }): Anthropic.Tool[] => {
  if (!opts.webSearch) return BASE_TOOLS;
  // Haiku-tier models only support the basic tool version; Sonnet/Opus tiers
  // get the dynamic-filtering variant.
  const type = opts.model.toLowerCase().includes("haiku")
    ? "web_search_20250305"
    : "web_search_20260209";
  return [
    ...BASE_TOOLS,
    { type, name: "web_search", max_uses: MAX_WEB_SEARCHES } as unknown as Anthropic.Tool,
  ];
};

/**
 * Pull {url, title} citations out of hosted web_search result blocks. An
 * error-shaped result (content is an object, not an array) is skipped — the
 * model sees the error inline and moves on; we just don't cite anything.
 */
const collectSources = (content: Anthropic.Message["content"], out: Map<string, string>): void => {
  for (const block of content) {
    const b = block as { type?: string; content?: unknown };
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      const { url, title } = r as { url?: unknown; title?: unknown };
      if (typeof url !== "string" || url.length === 0) continue;
      if (out.size >= MAX_SOURCES || out.has(url)) continue;
      out.set(url, typeof title === "string" && title.length > 0 ? title : url);
    }
  }
};

const FALLBACK_CLARIFY =
  "I can help turn a trading idea into a live Polymarket strategy — try something like “buy YES on the Fed cutting rates if it dips below 40¢”.";

export const generateStrategy = async (
  deps: GenerateDeps,
  req: GenerateRequest,
): Promise<GenerateResult> => {
  const nowMs = deps.nowMs ?? Date.now();
  const stage = (s: GenerateStage, detail?: string): void => deps.onStage?.(s, detail);
  const checkAborted = (): void => {
    if (deps.signal?.aborted) throw new GenerateAborted();
  };

  let userContent = req.currentDefinition
    ? `Current strategy definition (the user is refining this — keep bound markets via source:"current"):\n\`\`\`json\n${JSON.stringify(req.currentDefinition)}\n\`\`\`\n\n${req.prompt}`
    : req.prompt;

  const candidates: MarketSearchHit[] = [];
  let repairCount = 0;

  // @-pinned markets: resolved and verified HERE (never trusted from the
  // client), then seeded as pre-verified candidates so the model can skip
  // the search round entirely. Unresolvable ids are dropped.
  if (req.pinnedConditionIds && req.pinnedConditionIds.length > 0) {
    for (const conditionId of req.pinnedConditionIds.slice(0, 4)) {
      const found = await deps.gammaClient.findMarket({ conditionId });
      if (found.ok && found.value) {
        candidates.push(hitFromGammaMarket(found.value));
      } else {
        deps.logger.warn(
          { conditionId: conditionId.slice(0, 16) },
          "ai.generate pinned market unresolved",
        );
      }
    }
    if (candidates.length > 0) {
      userContent += `\n\nPinned markets (pre-verified candidates — reference by index, no search needed):\n${JSON.stringify(presentHits(candidates, 0))}`;
    }
  }

  // Pre-search seeding: on a fresh generation (no pins, no history, nothing to
  // refine) run the smart search on the raw prompt server-side and hand the
  // model pre-verified candidates up front. The common case then finishes in
  // ONE model call instead of a search round-trip. A seed that ran counts as
  // a search so the Gamma budget of ADR-0015 §6 still holds.
  let seeded = false;
  if (!req.currentDefinition && req.history.length === 0 && candidates.length === 0) {
    stage("searching", req.prompt.slice(0, 80));
    const seedRes = await smartSearchMarketHits(deps.gammaClient, req.prompt, {
      limit: SEARCH_HITS_PER_QUERY,
      maxFanOut: SEARCH_FAN_OUT,
    });
    if (seedRes.ok && seedRes.value.length > 0) {
      seeded = true;
      candidates.push(...seedRes.value);
      userContent += `\n\nPre-searched candidates (live results for this idea — pre-verified; reference by index; call search_markets only if none of these fit):\n${JSON.stringify(presentHits(seedRes.value, 0))}`;
    }
  }
  let searches = seeded ? 1 : 0;
  let statsCalls = 0;
  let webSearches = 0;
  const sources = new Map<string, string>();
  const maxCalls = seeded ? MAX_MODEL_CALLS_SEEDED : MAX_MODEL_CALLS;
  const tools = buildTools({ webSearch: deps.webSearch === true, model: deps.model });

  // Decorate every user-facing result with collected citations + counters.
  const finish = (r: GenerateResult): GenerateResult => {
    if (r.status === "error") return r;
    const src = sources.size > 0 ? [...sources].map(([url, title]) => ({ url, title })) : undefined;
    if (r.status === "ok")
      return { ...r, statsCalls, webSearches, ...(src ? { sources: src } : {}) };
    return src ? { ...r, sources: src } : r;
  };

  // Soft-failure ladder — a genuine trading prompt must never dead-end in a
  // hard error. Refinement turns clarify (a fallback draft would clobber the
  // user's strategy); fresh turns get the guaranteed draft whenever a verified
  // candidate exists, else a clarify that asks for the event by name.
  const failSoft = (modelCalls: number): GenerateResult => {
    if (req.currentDefinition) {
      return {
        status: "clarify",
        question:
          "I couldn't apply that change — try describing it differently, e.g. name the condition or the amount you want to change.",
      };
    }
    const fallback = buildFallbackDraft(candidates, nowMs, modelCalls);
    if (fallback) return fallback;
    return {
      status: "clarify",
      question:
        candidates.length === 0
          ? "I couldn't find a live market for that — can you name the event? For example: “Fed cuts rates by December” or “BTC above $150k”."
          : "I couldn't turn that into a valid strategy — try naming a market, a price, and what should happen (alert me or prepare an order).",
    };
  };

  const messages: Anthropic.MessageParam[] = [
    ...req.history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
    { role: "user", content: userContent },
  ];

  // Haiku-tier models reject the `effort` parameter (400), and non-Anthropic
  // compatible endpoints may too — only send it where it's known to work.
  const supportsEffort = !deps.model.toLowerCase().includes("haiku") && !deps.baseUrl;

  for (let call = 1; call <= maxCalls; call++) {
    checkAborted();
    stage("drafting");
    let resp: Anthropic.Message;
    try {
      resp = await deps.aiClient.create({
        model: deps.model,
        max_tokens: 4096,
        ...(supportsEffort ? { output_config: { effort: "medium" as const } } : {}),
        // Two system blocks: the stable prefix carries the cache mark; the
        // current-time line sits AFTER it so the timestamp can't invalidate
        // the cache on every request.
        system: [
          {
            type: "text",
            text: STABLE_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: timeBlock(new Date(nowMs).toISOString()) },
        ],
        tools,
        messages,
      });
    } catch (err) {
      deps.logger.warn({ err, call }, "ai.generate upstream error");
      // A mid-generation outage still yields a draft when verified candidates
      // are already in hand (common once seeding ran). Refinements and
      // candidate-less requests keep the honest 502.
      if (!req.currentDefinition) {
        const fallback = buildFallbackDraft(candidates, nowMs, call - 1);
        if (fallback) return finish(fallback);
      }
      return {
        status: "error",
        code: "AI_UPSTREAM",
        message: "The AI service is unavailable right now — try again in a moment.",
      };
    }

    if (resp.stop_reason === "refusal") {
      return finish({ status: "clarify", question: FALLBACK_CLARIFY });
    }

    // Hosted web_search runs server-side at Anthropic: citations arrive as
    // result blocks in the SAME response; a long server-tool turn may pause.
    collectSources(resp.content, sources);
    let sawWebSearch = false;
    for (const b of resp.content) {
      const t = b as { type?: string; name?: string };
      if (t.type === "server_tool_use" && t.name === "web_search") {
        webSearches++;
        sawWebSearch = true;
      }
    }
    if (sawWebSearch) stage("researching");
    if (resp.stop_reason === "pause_turn") {
      // Resume the server-tool loop: echo the assistant turn, no user message.
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      // Text-only turn: surface it as a clarification rather than failing.
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return finish({ status: "clarify", question: text || FALLBACK_CLARIFY });
    }

    const clarify = toolUses.find((t) => t.name === CLARIFY_TOOL.name);
    if (clarify) {
      const parsed = ClarifyInputZ.safeParse(clarify.input);
      return finish({
        status: "clarify",
        question: parsed.success ? parsed.data.question : FALLBACK_CLARIFY,
      });
    }

    // Product Q&A rides the clarify wire shape: the panel already renders it
    // as an assistant markdown bubble, so no client change is needed.
    const answer = toolUses.find((t) => t.name === ANSWER_TOOL.name);
    if (answer) {
      const parsed = AnswerInputZ.safeParse(answer.input);
      return finish({
        status: "clarify",
        question: parsed.success ? parsed.data.answer.slice(0, 1500) : FALLBACK_CLARIFY,
      });
    }

    // Execute searches and stats lookups first so a same-turn create_strategy
    // failure can still answer every tool_use block in ONE user message (API
    // requirement).
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === SEARCH_MARKETS_TOOL.name) {
        const parsed = SearchMarketsInputZ.safeParse(tu.input);
        const query = parsed.success ? parsed.data.query.trim().slice(0, 80) : "";
        if (!parsed.success || query.length < 2) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: "INVALID_QUERY",
              message: "query must be 2–80 chars",
            }),
            is_error: true,
          });
          continue;
        }
        if (searches >= MAX_SEARCHES) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: "SEARCH_LIMIT",
              message: "No more searches — use the candidates you already have, or clarify.",
            }),
            is_error: true,
          });
          continue;
        }
        searches++;
        checkAborted();
        stage("searching", query);
        const hits = await smartSearchMarketHits(deps.gammaClient, query, {
          limit: SEARCH_HITS_PER_QUERY,
          maxFanOut: SEARCH_FAN_OUT,
        });
        if (!hits.ok) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: "SEARCH_FAILED", message: "market search failed" }),
            is_error: true,
          });
          continue;
        }
        const base = candidates.length;
        candidates.push(...hits.value);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ candidates: presentHits(hits.value, base) }),
        });
        continue;
      }

      if (tu.name === GET_MARKET_STATS_TOOL.name) {
        const parsed = GetMarketStatsInputZ.safeParse(tu.input);
        const hit = parsed.success ? candidates[parsed.data.index] : undefined;
        if (!parsed.success || !hit) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: "UNKNOWN_MARKET",
              message: "only candidate indexes you were shown are valid.",
            }),
            is_error: true,
          });
          continue;
        }
        if (statsCalls >= MAX_STATS_CALLS) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: "STATS_LIMIT",
              message: "No more stats lookups — decide with what you have.",
            }),
            is_error: true,
          });
          continue;
        }
        let pos = hit.outcomes.findIndex(
          (o) => o.toLowerCase() === parsed.data.outcome.toLowerCase(),
        );
        if (pos === -1) pos = 0;
        if (!hit.tokenIds[pos]) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: "UNKNOWN_MARKET",
              message: `candidate ${parsed.data.index} has no token for that outcome.`,
            }),
            is_error: true,
          });
          continue;
        }
        statsCalls++;
        checkAborted();
        stage("analyzing", hit.title.slice(0, 80));
        const stats = await buildMarketStats(
          { clobClient: deps.clobClient, gammaClient: deps.gammaClient, logger: deps.logger },
          hit,
          pos,
        );
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(stats),
        });
      }
    }

    const create = toolUses.find((t) => t.name === CREATE_STRATEGY_TOOL.name);
    if (create) {
      const parsed = CreateStrategyInputZ.safeParse(create.input);
      let issues: MappingIssue[] = [];
      if (parsed.success) {
        try {
          const built = buildDefinition(parsed.data, candidates, req.currentDefinition);
          const validation = validateStrategyDefinition(built.definition, nowMs);
          if (validation.length === 0) {
            return finish({
              status: "ok",
              definition: built.definition,
              summary: parsed.data.summary,
              warnings: built.warnings,
              // Display-only field: clamp instead of failing the whole draft.
              openQuestions: parsed.data.open_questions.slice(0, 3).map((s) => s.slice(0, 200)),
              markets: built.markets,
              modelCalls: call,
            });
          }
          issues = validation.map((i) => ({ code: i.code, message: i.message }));
        } catch (err) {
          if (err instanceof MappingError) issues = err.issues;
          else throw err;
        }
      } else {
        issues = [{ code: "MALFORMED_INPUT", message: "create_strategy input did not parse" }];
      }

      if (repairCount >= MAX_REPAIR_ROUNDS) {
        deps.logger.warn({ issues }, "ai.generate failed after repair rounds");
        return finish(failSoft(call));
      }
      repairCount++;
      stage("repairing");
      results.push({
        type: "tool_result",
        tool_use_id: create.id,
        content: JSON.stringify({ ok: false, issues }),
        is_error: true,
      });
    }

    if (results.length === 0) {
      // Unknown tool names only — answer them so the loop can continue.
      for (const tu of toolUses) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: "UNKNOWN_TOOL" }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: results });
  }

  deps.logger.warn({ maxCalls }, "ai.generate model-call budget exhausted");
  return finish(failSoft(maxCalls));
};
