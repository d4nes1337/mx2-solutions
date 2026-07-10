import { z } from "zod";

/**
 * Tool contract for the NL→Smart Order generator.
 *
 * Design notes (ADR-0011):
 *  - `strict: true` on every tool: the API guarantees inputs validate against
 *    the schema exactly. Strict schemas forbid recursion, so the expression
 *    tree is a BOUNDED unrolling — root children are conditions or ONE level
 *    of sub-groups whose children are conditions. That matches
 *    EXPR_LIMITS.maxDepth = 3 (root → group → condition) exactly.
 *  - The model never sees conditionIds/tokenIds. It references markets by
 *    search-result `index` (or, when iterating, by a tokenId already present
 *    in the user's current definition). The server binds real MarketRefs from
 *    its own candidate cache, so the model cannot fabricate an id that binds.
 *  - Conditions are one flattened shape (kind + nullable per-kind fields)
 *    instead of a 5-way union: strict-mode unions of objects bloat the schema
 *    and confuse smaller models; the server re-discriminates with zod.
 *  - Numeric ranges/array lengths are deliberately absent (unsupported in
 *    strict mode) — `validateStrategyDefinition` enforces them server-side,
 *    with one repair round-trip when the model misses.
 */

const MARKET_SELECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source", "index", "tokenId", "outcome"],
  properties: {
    source: {
      type: "string",
      enum: ["search", "current"],
      description:
        "search = a candidate returned by search_markets; current = a market already in the user's current definition.",
    },
    index: {
      type: "integer",
      description: "Candidate index from search_markets when source=search; 0 when source=current.",
    },
    tokenId: {
      type: "string",
      description:
        "tokenId copied from the current definition when source=current; empty string when source=search.",
    },
    outcome: {
      type: "string",
      description: 'Outcome label exactly as listed by search_markets, e.g. "Yes" or "No".',
    },
  },
} as const;

const CONDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "market",
    "source",
    "comparator",
    "threshold",
    "priceBound",
    "minNotional",
    "minLevels",
    "startMs",
    "endMs",
  ],
  properties: {
    kind: {
      type: "string",
      enum: ["price", "spread", "cumulative_notional", "visible_levels", "time_window"],
    },
    market: {
      anyOf: [MARKET_SELECTOR_SCHEMA, { type: "null" }],
      description: "null ONLY for time_window conditions.",
    },
    source: {
      type: "string",
      enum: ["ask", "bid"],
      description:
        "Book side. price: ask for buy-side logic, bid for sell-side. Ignored for spread/time_window.",
    },
    comparator: {
      type: "string",
      enum: ["lte", "gte"],
      description: "Used by price and spread conditions.",
    },
    threshold: {
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "price/spread: probability 0–1 (e.g. 58¢ = 0.58). null for other kinds.",
    },
    priceBound: {
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "cumulative_notional/visible_levels: price bound 0–1. null otherwise.",
    },
    minNotional: {
      anyOf: [{ type: "number" }, { type: "null" }],
      description: "cumulative_notional: minimum USD liquidity within the bound. null otherwise.",
    },
    minLevels: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "visible_levels: minimum visible book levels. null otherwise.",
    },
    startMs: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "time_window: unix ms start (null = unbounded). null for other kinds.",
    },
    endMs: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "time_window: unix ms end (null = unbounded). null for other kinds.",
    },
  },
} as const;

const CONDITION_NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "condition"],
  properties: {
    type: { type: "string", enum: ["condition"] },
    condition: CONDITION_SCHEMA,
  },
} as const;

const SUBGROUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "op", "children"],
  properties: {
    type: { type: "string", enum: ["group"] },
    op: {
      type: "string",
      enum: ["and", "or", "not"],
      description: "not must wrap exactly one child.",
    },
    children: { type: "array", items: CONDITION_NODE_SCHEMA },
  },
} as const;

export const SEARCH_MARKETS_TOOL = {
  name: "search_markets",
  description:
    "Search live Polymarket markets. ALWAYS call this before referencing any market — never invent markets, prices or ids. Returns numbered candidates with current outcome prices; refer to a candidate by its `index` in create_strategy.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "2–80 characters of event/market keywords, e.g. 'bitcoin 150k december'.",
      },
    },
  },
} as const;

export const CREATE_STRATEGY_TOOL = {
  name: "create_strategy",
  description:
    "Your FINAL answer: emit the complete Smart Order. Reference markets only by search_markets index (source=search) or by a tokenId already present in the user's current definition (source=current). Call exactly once, after any needed searches.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["name", "summary", "rootOp", "conditions", "holdsForMs", "action", "recurrence"],
    properties: {
      name: { type: "string", description: "Short strategy name shown to the user (≤120 chars)." },
      summary: {
        type: "string",
        description:
          "One friendly plain-English sentence describing what the strategy does. No promises of profit.",
      },
      rootOp: {
        type: "string",
        enum: ["and", "or"],
        description: "How the top-level conditions combine.",
      },
      conditions: {
        type: "array",
        items: { anyOf: [CONDITION_NODE_SCHEMA, SUBGROUP_SCHEMA] },
        description: "Top-level condition nodes (≤12 conditions, ≤4 markets total).",
      },
      holdsForMs: {
        type: "integer",
        description:
          "How long the WHOLE expression must hold continuously before triggering. Default 300000 (5 minutes) unless the user says otherwise.",
      },
      action: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "market", "side", "price", "size"],
        properties: {
          kind: {
            type: "string",
            enum: ["alert", "order"],
            description: "alert = notify only. order = prepare a limit order for the user to sign.",
          },
          market: {
            anyOf: [MARKET_SELECTOR_SCHEMA, { type: "null" }],
            description: "Required when kind=order; null for alert.",
          },
          side: { type: "string", enum: ["BUY", "SELL"] },
          price: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description:
              "Limit price 0–1, anchored to the candidate's current price. null for alert.",
          },
          size: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description:
              "Order size in SHARES (not USD). Default 100 when unspecified. null for alert.",
          },
        },
      },
      recurrence: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "maxRepeats", "cooldownMs"],
        properties: {
          kind: { type: "string", enum: ["once", "repeat"] },
          maxRepeats: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "repeat only: 2–100. null for once.",
          },
          cooldownMs: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "repeat only: quiet period after a trigger, ms. null for once.",
          },
        },
      },
    },
  },
} as const;

export const CLARIFY_TOOL = {
  name: "clarify",
  description:
    "Use INSTEAD of create_strategy when the request is not about a Polymarket trading strategy, is too ambiguous to build, or no matching market exists. Ask exactly one question, or politely explain what you can help with.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", description: "One question or one short polite explanation." },
    },
  },
} as const;

// ── zod mirrors — defense-in-depth parse of tool_use inputs ─────────────────

export const MarketSelectorZ = z.object({
  source: z.enum(["search", "current"]),
  index: z.number().int(),
  tokenId: z.string(),
  outcome: z.string(),
});
export type AiMarketSelector = z.infer<typeof MarketSelectorZ>;

export const AiConditionZ = z.object({
  kind: z.enum(["price", "spread", "cumulative_notional", "visible_levels", "time_window"]),
  market: MarketSelectorZ.nullable(),
  source: z.enum(["ask", "bid"]),
  comparator: z.enum(["lte", "gte"]),
  threshold: z.number().nullable(),
  priceBound: z.number().nullable(),
  minNotional: z.number().nullable(),
  minLevels: z.number().int().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
});
export type AiCondition = z.infer<typeof AiConditionZ>;

export const AiConditionNodeZ = z.object({
  type: z.literal("condition"),
  condition: AiConditionZ,
});

export const AiSubGroupZ = z.object({
  type: z.literal("group"),
  op: z.enum(["and", "or", "not"]),
  children: z.array(AiConditionNodeZ),
});

export const CreateStrategyInputZ = z.object({
  name: z.string(),
  summary: z.string(),
  rootOp: z.enum(["and", "or"]),
  conditions: z.array(z.union([AiConditionNodeZ, AiSubGroupZ])),
  holdsForMs: z.number().int(),
  action: z.object({
    kind: z.enum(["alert", "order"]),
    market: MarketSelectorZ.nullable(),
    side: z.enum(["BUY", "SELL"]),
    price: z.number().nullable(),
    size: z.number().nullable(),
  }),
  recurrence: z.object({
    kind: z.enum(["once", "repeat"]),
    maxRepeats: z.number().int().nullable(),
    cooldownMs: z.number().int().nullable(),
  }),
});
export type CreateStrategyInput = z.infer<typeof CreateStrategyInputZ>;

export const SearchMarketsInputZ = z.object({ query: z.string() });
export const ClarifyInputZ = z.object({ question: z.string() });
