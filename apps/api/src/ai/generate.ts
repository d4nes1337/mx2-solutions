import type Anthropic from "@anthropic-ai/sdk";
import type { GammaClient } from "@mx2/polymarket-client";
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
  searchMarketHits,
  type MarketSearchHit,
} from "../lib/market-search.js";
import type { AiClient } from "./client.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  CLARIFY_TOOL,
  CREATE_STRATEGY_TOOL,
  ClarifyInputZ,
  CreateStrategyInputZ,
  SEARCH_MARKETS_TOOL,
  SearchMarketsInputZ,
  type AiCondition,
  type AiMarketSelector,
  type CreateStrategyInput,
} from "./tools.js";

// Hard loop caps: a paid upstream on a public endpoint must be bounded.
const MAX_MODEL_CALLS = 6;
const MAX_SEARCHES = 4;
const SEARCH_HITS_PER_QUERY = 5;

/** Minimal logging surface (satisfied by both pino and Fastify's req.log). */
export interface GenerateLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface GenerateDeps {
  aiClient: AiClient;
  gammaClient: GammaClient;
  logger: GenerateLogger;
  model: string;
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
      /** Display metadata for every bound market, keyed by tokenId. */
      markets: Record<string, GeneratedMarketMeta>;
      modelCalls: number;
    }
  | { status: "clarify"; question: string }
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
    action = {
      kind: "order",
      market: resolve(input.action.market),
      side: input.action.side,
      price: input.action.price ?? 0,
      size: input.action.size ?? 100,
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

// ── The generation loop ──────────────────────────────────────────────────────

const TOOLS = [
  SEARCH_MARKETS_TOOL,
  CREATE_STRATEGY_TOOL,
  CLARIFY_TOOL,
] as unknown as Anthropic.Tool[];

const FALLBACK_CLARIFY =
  "I can help turn a trading idea into a live Polymarket strategy — try something like “buy YES on the Fed cutting rates if it dips below 40¢”.";

export const generateStrategy = async (
  deps: GenerateDeps,
  req: GenerateRequest,
): Promise<GenerateResult> => {
  const nowMs = deps.nowMs ?? Date.now();

  let userContent = req.currentDefinition
    ? `Current strategy definition (the user is refining this — keep bound markets via source:"current"):\n\`\`\`json\n${JSON.stringify(req.currentDefinition)}\n\`\`\`\n\n${req.prompt}`
    : req.prompt;

  const candidates: MarketSearchHit[] = [];
  let searches = 0;
  let repairUsed = false;

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

  const messages: Anthropic.MessageParam[] = [
    ...req.history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
    { role: "user", content: userContent },
  ];

  // Haiku-tier models reject the `effort` parameter (400) — only send it on
  // tiers that support it.
  const supportsEffort = !deps.model.toLowerCase().includes("haiku");

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    let resp: Anthropic.Message;
    try {
      resp = await deps.aiClient.create({
        model: deps.model,
        max_tokens: 4096,
        ...(supportsEffort ? { output_config: { effort: "medium" as const } } : {}),
        system: [
          {
            type: "text",
            text: buildSystemPrompt(new Date(nowMs).toISOString()),
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      deps.logger.warn({ err, call }, "ai.generate upstream error");
      return {
        status: "error",
        code: "AI_UPSTREAM",
        message: "The AI service is unavailable right now — try again in a moment.",
      };
    }

    if (resp.stop_reason === "refusal") {
      return { status: "clarify", question: FALLBACK_CLARIFY };
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      // Text-only turn: surface it as a clarification rather than failing.
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { status: "clarify", question: text || FALLBACK_CLARIFY };
    }

    const clarify = toolUses.find((t) => t.name === CLARIFY_TOOL.name);
    if (clarify) {
      const parsed = ClarifyInputZ.safeParse(clarify.input);
      return {
        status: "clarify",
        question: parsed.success ? parsed.data.question : FALLBACK_CLARIFY,
      };
    }

    // Execute searches first so a same-turn create_strategy failure can still
    // answer every tool_use block in ONE user message (API requirement).
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name !== SEARCH_MARKETS_TOOL.name) continue;
      const parsed = SearchMarketsInputZ.safeParse(tu.input);
      const query = parsed.success ? parsed.data.query.trim().slice(0, 80) : "";
      if (!parsed.success || query.length < 2) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: "INVALID_QUERY", message: "query must be 2–80 chars" }),
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
      const hits = await searchMarketHits(deps.gammaClient, query, SEARCH_HITS_PER_QUERY);
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
            return {
              status: "ok",
              definition: built.definition,
              summary: parsed.data.summary,
              warnings: built.warnings,
              markets: built.markets,
              modelCalls: call,
            };
          }
          issues = validation.map((i) => ({ code: i.code, message: i.message }));
        } catch (err) {
          if (err instanceof MappingError) issues = err.issues;
          else throw err;
        }
      } else {
        issues = [{ code: "MALFORMED_INPUT", message: "create_strategy input did not parse" }];
      }

      if (repairUsed) {
        deps.logger.warn({ issues }, "ai.generate failed after repair round");
        return {
          status: "error",
          code: "AI_GENERATION_FAILED",
          message: "The AI couldn't produce a valid strategy for that — try rephrasing.",
        };
      }
      repairUsed = true;
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

  return {
    status: "error",
    code: "AI_GENERATION_FAILED",
    message: "The AI took too many steps for that request — try a simpler phrasing.",
  };
};
