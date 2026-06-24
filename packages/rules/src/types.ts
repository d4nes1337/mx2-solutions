/**
 * Pure domain types for the conditional-rules engine (L2–L3 of the engine
 * layering — see docs/adr/0005). Nothing here performs I/O: the engine is a set
 * of deterministic functions over an ordered sequence of normalized market
 * events, which is what makes replay (docs/04 §8) possible.
 */

/** A single aggregated price level from the public order book. */
export interface BookLevel {
  /** Probability price in (0,1). */
  readonly price: number;
  /** Visible size in shares. */
  readonly size: number;
}

export type MarketStatus = "open" | "paused" | "closed" | "resolved" | "unknown";

export type Side = "BUY" | "SELL";

/** Which side of the book a liquidity/price predicate reads. */
export type BookSide = "ask" | "bid";

/**
 * Normalized snapshot of one outcome token at a point in time. `asks` are
 * sorted best-first (ascending price); `bids` best-first (descending price).
 * Both clocks are kept: `sourceTimeMs` is the upstream event time, `receivedAtMs`
 * is when we observed it — divergence beyond a threshold is clock skew.
 */
export interface MarketDataView {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly marketStatus: MarketStatus;
  readonly sourceTimeMs: number;
  readonly receivedAtMs: number;
}

// ── Predicates (MVP: combined with AND, matching docs/04 §2 canonical example) ──

/** best_ask ≤ threshold (BUY) or best_bid ≥ threshold (SELL). */
export interface PriceCondition {
  readonly kind: "price";
  readonly source: BookSide;
  readonly comparator: "lte" | "gte";
  readonly threshold: number;
}

/** Cumulative USD notional within a price band on one side ≥ minNotional. */
export interface CumulativeNotionalCondition {
  readonly kind: "cumulative_notional";
  readonly source: BookSide;
  /** ask: include levels with price ≤ priceBound; bid: price ≥ priceBound. */
  readonly priceBound: number;
  readonly minNotional: number;
}

/** Count of non-empty visible levels within a price band ≥ minLevels. */
export interface VisibleLevelsCondition {
  readonly kind: "visible_levels";
  readonly source: BookSide;
  readonly priceBound: number;
  readonly minLevels: number;
}

export type Predicate = PriceCondition | CumulativeNotionalCondition | VisibleLevelsCondition;

// ── Action template (L4). MVP implements only `prepare_order`. The union is the
//    seam where a future continuous quoting strategy (rebate farmer) slots in. ──

/** Prepare exactly one limit order for manual confirmation + signature. */
export interface PrepareOrderAction {
  readonly kind: "prepare_order";
  readonly side: Side;
  readonly price: number;
  readonly size: number;
  readonly orderType: "GTC";
}

export type RuleAction = PrepareOrderAction;

export type Recurrence = "once";

/**
 * Immutable rule definition. Its hash (computed over a canonical serialization)
 * is recorded in evidence so a trigger can be tied to the exact rule version.
 */
export interface RuleDefinition {
  readonly version: 1;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly outcomeSide: Side;
  readonly predicates: readonly Predicate[];
  readonly continuousWindowMs: number;
  readonly maxDataAgeMs: number;
  readonly action: RuleAction;
  readonly recurrence: Recurrence;
  /** Wall-clock expiry of the rule itself, or null for no expiry. */
  readonly expiresAtMs: number | null;
}

export type RuleStatus =
  | "DRAFT"
  | "ACTIVE_WAITING"
  | "ACTIVE_ACCUMULATING"
  | "PAUSED"
  | "TRIGGERED_AWAITING_USER"
  | "EXECUTED_MANUALLY"
  | "EXPIRED"
  | "CANCELLED"
  | "INVALIDATED"
  | "ERROR";

export type ReasonCode =
  | "PRICE_OK"
  | "PRICE_FAIL"
  | "NOTIONAL_OK"
  | "NOTIONAL_FAIL"
  | "LEVELS_OK"
  | "LEVELS_FAIL"
  | "DATA_FRESH"
  | "DATA_STALE"
  | "WINDOW_STARTED"
  | "WINDOW_COMPLETE"
  | "RECONNECT_RESET"
  | "TICK_SIZE_CHANGED"
  | "MARKET_PAUSED"
  | "MARKET_CLOSED"
  | "MARKET_RESOLVED"
  | "EXPIRED"
  | "PAUSED"
  | "RESUMED"
  | "CANCELLED"
  | "TOKEN_AMBIGUOUS";

/**
 * Mutable per-rule runtime carried between events. Persisted by the worker as
 * columns on `conditional_rules`. `trueSinceMs` is the processing-clock instant
 * the predicate first became continuously true+fresh (null when not accumulating).
 */
export interface RuleRuntime {
  readonly status: RuleStatus;
  readonly trueSinceMs: number | null;
  readonly lastEventTimeMs: number | null;
}

/** Events the state machine consumes. `nowMs` is the single processing clock. */
export type EvalEvent =
  | { readonly type: "book"; readonly view: MarketDataView; readonly nowMs: number }
  | { readonly type: "tick"; readonly latestView: MarketDataView | null; readonly nowMs: number }
  | { readonly type: "reconnect"; readonly nowMs: number }
  | { readonly type: "tick_size_change"; readonly nowMs: number }
  | { readonly type: "market_status"; readonly status: MarketStatus; readonly nowMs: number }
  | { readonly type: "pause"; readonly nowMs: number }
  | { readonly type: "resume"; readonly nowMs: number }
  | { readonly type: "cancel"; readonly nowMs: number }
  | { readonly type: "expire"; readonly nowMs: number };

export interface StateTransition {
  readonly from: RuleStatus;
  readonly to: RuleStatus;
  readonly reason: ReasonCode;
  readonly atMs: number;
}

/** Per-predicate evaluation detail (drives the "would-trigger-now" UI + evidence). */
export interface PredicateResult {
  readonly kind: Predicate["kind"];
  readonly satisfied: boolean;
  readonly actual: number | null;
  readonly threshold: number;
  readonly reason: ReasonCode;
}

export interface Evaluation {
  readonly satisfied: boolean;
  readonly results: readonly PredicateResult[];
  readonly reasonCodes: readonly ReasonCode[];
}

/**
 * Provable trigger evidence (docs/04 §5). Self-contained: enough to explain and
 * (with the rule definition) replay the decision without retaining every book
 * change forever.
 */
export interface TriggerEvidence {
  readonly evaluatorVersion: string;
  readonly ruleDefinitionHash: string;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly triggeredAtMs: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly cumulativeNotional: number | null;
  readonly cumulativeShares: number | null;
  readonly visibleLevels: number | null;
  readonly sourceTimeMs: number;
  readonly receivedAtMs: number;
  readonly marketStatus: MarketStatus;
  readonly reasonCodes: readonly ReasonCode[];
  /** The action the user is asked to confirm — recomputed fresh at confirm time. */
  readonly preparedAction: RuleAction;
}

export interface TransitionResult {
  readonly runtime: RuleRuntime;
  /** Non-null only when `status` changed. */
  readonly transition: StateTransition | null;
  /** Non-null only on the single transition into TRIGGERED_AWAITING_USER. */
  readonly trigger: TriggerEvidence | null;
}
