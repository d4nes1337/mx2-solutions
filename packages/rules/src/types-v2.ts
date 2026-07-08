/**
 * Smart Order DSL v2 (ADR-0010). Extends the v1 rule model with: an AND/OR/NOT
 * expression tree over typed conditions, per-condition market references
 * (cross-market "@market" strategies), spread + time-window conditions, repeat
 * recurrence with cooldown, and per-strategy execution limits.
 *
 * Everything here stays pure and serializable (plain JSON, no Maps/Dates) so
 * the deterministic-replay property of the v1 engine is preserved. v1 rules
 * are read through `normalizeDefinition` (compat.ts) — never rewritten.
 */
import type {
  BookSide,
  MarketDataView,
  MarketStatus,
  ReasonCode,
  RuleStatus,
  Side,
  StateTransition,
  TickSize,
} from "./types.js";

/** Which market (and outcome token) a condition or order binds to. */
export interface MarketRef {
  readonly conditionId: string;
  readonly tokenId: string;
  /** Display label for the outcome (e.g. "YES"); not used in evaluation. */
  readonly outcome: string;
  /** Display-only market title so summaries read well anywhere; never evaluated. */
  readonly title?: string | undefined;
}

// ── Conditions ──────────────────────────────────────────────────────────────

export interface PriceConditionV2 {
  readonly kind: "price";
  readonly market: MarketRef;
  readonly source: BookSide;
  readonly comparator: "lte" | "gte";
  readonly threshold: number;
}

/** bestAsk − bestBid compared against a threshold. */
export interface SpreadConditionV2 {
  readonly kind: "spread";
  readonly market: MarketRef;
  readonly comparator: "lte" | "gte";
  readonly threshold: number;
}

export interface CumulativeNotionalConditionV2 {
  readonly kind: "cumulative_notional";
  readonly market: MarketRef;
  readonly source: BookSide;
  readonly priceBound: number;
  readonly minNotional: number;
}

export interface VisibleLevelsConditionV2 {
  readonly kind: "visible_levels";
  readonly market: MarketRef;
  readonly source: BookSide;
  readonly priceBound: number;
  readonly minLevels: number;
}

/**
 * Pure wall-clock window: satisfied while startMs ≤ now ≤ endMs (either bound
 * may be null = unbounded). Binds to no market — freshness never applies.
 */
export interface TimeWindowConditionV2 {
  readonly kind: "time_window";
  readonly startMs: number | null;
  readonly endMs: number | null;
}

export type ConditionV2 =
  | PriceConditionV2
  | SpreadConditionV2
  | CumulativeNotionalConditionV2
  | VisibleLevelsConditionV2
  | TimeWindowConditionV2;

// ── Expression tree ─────────────────────────────────────────────────────────

export interface ConditionNode {
  readonly type: "condition";
  /** Stable node id — referenced by the builder UI and the evaluation result tree. */
  readonly id: string;
  readonly condition: ConditionV2;
}

export interface GroupNode {
  readonly type: "group";
  readonly id: string;
  /** "not" groups must have exactly one child (enforced by validation). */
  readonly op: "and" | "or" | "not";
  readonly children: readonly ExprNode[];
}

export type ExprNode = ConditionNode | GroupNode;

/** Structural caps keeping evaluation, subscriptions and evidence bounded. */
export const EXPR_LIMITS = {
  maxDepth: 3,
  maxConditions: 12,
  maxMarkets: 4,
} as const;

// ── Actions ─────────────────────────────────────────────────────────────────

/** Notify only — every trigger already records evidence + an audit event. */
export interface AlertAction {
  readonly kind: "alert";
}

/**
 * Place a limit order. execution "prepare" = trigger awaits the user's
 * signature (v1 manual flow); "auto" = the worker signs + submits from the
 * user's trading wallet (requires per-strategy limits + feature gates).
 */
export interface OrderActionV2 {
  readonly kind: "order";
  readonly market: MarketRef;
  readonly side: Side;
  readonly price: number;
  readonly size: number;
  readonly orderType: "GTC";
  readonly execution: "prepare" | "auto";
  readonly negRisk?: boolean;
  readonly tickSize?: TickSize;
}

/** Stop another strategy when this one triggers (side effect is worker-managed). */
export interface StopStrategyAction {
  readonly kind: "stop_strategy";
  readonly targetStrategyId: string;
}

export type ActionV2 = AlertAction | OrderActionV2 | StopStrategyAction;

// ── Recurrence and limits ───────────────────────────────────────────────────

export type RecurrenceV2 =
  | { readonly kind: "once" }
  | {
      readonly kind: "repeat";
      readonly maxRepeats: number;
      /** Minimum quiet period after a trigger before accumulation may restart. */
      readonly cooldownMs: number;
    };

/** Hard per-strategy spend caps. Required whenever action.execution === "auto". */
export interface StrategyLimits {
  readonly maxNotionalPerOrder: number;
  readonly maxTotalNotional: number;
  readonly maxDailyNotional: number;
}

// ── Definition ──────────────────────────────────────────────────────────────

export interface StrategyDefinition {
  readonly version: 2;
  /** User-facing strategy name ("" for compat-normalized v1 rules). */
  readonly name: string;
  /** Template provenance (analytics/copy only), or null for scratch builds. */
  readonly templateId: string | null;
  readonly expr: ExprNode;
  /** Root-level continuous window: the whole expression must hold this long. */
  readonly holdsForMs: number;
  readonly maxDataAgeMs: number;
  readonly action: ActionV2;
  readonly recurrence: RecurrenceV2;
  readonly limits: StrategyLimits | null;
  readonly expiresAtMs: number | null;
}

// ── Runtime ─────────────────────────────────────────────────────────────────

/**
 * v2 runtime adds repeat bookkeeping to the v1 shape. Persisted by the worker
 * as columns on `conditional_rules` (migration 0009).
 */
export interface StrategyRuntime {
  readonly status: RuleStatus;
  readonly trueSinceMs: number | null;
  readonly lastEventTimeMs: number | null;
  readonly triggerCount: number;
  /** Non-null while in a post-trigger cooldown; accumulation is gated until then. */
  readonly cooldownUntilMs: number | null;
}

/** Views keyed by tokenId. Plain object (not Map) so fixtures stay serializable. */
export type ViewsByToken = Readonly<Record<string, MarketDataView>>;

export type EvalEventV2 =
  | { readonly type: "book"; readonly views: ViewsByToken; readonly nowMs: number }
  | { readonly type: "tick"; readonly views: ViewsByToken | null; readonly nowMs: number }
  | { readonly type: "reconnect"; readonly nowMs: number }
  | { readonly type: "tick_size_change"; readonly nowMs: number }
  | {
      readonly type: "market_status";
      readonly tokenId: string;
      readonly status: MarketStatus;
      readonly nowMs: number;
    }
  | { readonly type: "pause"; readonly nowMs: number }
  | { readonly type: "resume"; readonly nowMs: number }
  | { readonly type: "cancel"; readonly nowMs: number }
  | { readonly type: "expire"; readonly nowMs: number };

// ── Evaluation result tree (drives builder live-state + evidence) ───────────

export interface ConditionResultV2 {
  readonly kind: ConditionV2["kind"];
  readonly satisfied: boolean;
  readonly actual: number | null;
  readonly threshold: number;
  readonly reason: ReasonCode;
  /** Token the condition read, or null for market-less conditions (time_window). */
  readonly tokenId: string | null;
  /** True when the bound market's data was missing or older than maxDataAgeMs. */
  readonly stale: boolean;
}

export type ExprResultNode =
  | {
      readonly type: "condition";
      readonly id: string;
      readonly satisfied: boolean;
      readonly result: ConditionResultV2;
    }
  | {
      readonly type: "group";
      readonly id: string;
      readonly op: GroupNode["op"];
      readonly satisfied: boolean;
      readonly children: readonly ExprResultNode[];
    };

export interface EvaluationV2 {
  /** Fail-closed: false whenever any referenced market's data is missing/stale. */
  readonly satisfied: boolean;
  readonly root: ExprResultNode;
  readonly reasonCodes: readonly ReasonCode[];
  /** Referenced tokens whose views were missing or stale at evaluation time. */
  readonly staleTokenIds: readonly string[];
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface MarketEvidenceSummary {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly sourceTimeMs: number;
  readonly receivedAtMs: number;
  readonly marketStatus: MarketStatus;
}

/**
 * v2 trigger evidence. Keeps the v1 flat fields for the primary market (the
 * order's market, else the first referenced one) so existing consumers of
 * trigger evidence keep working, and adds per-market summaries + the full
 * evaluation result tree.
 */
export interface TriggerEvidenceV2 {
  readonly evaluatorVersion: string;
  readonly ruleDefinitionHash: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly triggeredAtMs: number;
  readonly markets: readonly MarketEvidenceSummary[];
  readonly resultTree: ExprResultNode;
  readonly reasonCodes: readonly ReasonCode[];
  readonly preparedAction: ActionV2;
  /** 1-based index of this trigger within the strategy's recurrence. */
  readonly triggerNumber: number;
  // v1-compatible flat fields (primary market):
  readonly tokenId: string;
  readonly conditionId: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly sourceTimeMs: number;
  readonly receivedAtMs: number;
  readonly marketStatus: MarketStatus;
}

export interface TransitionResultV2 {
  readonly runtime: StrategyRuntime;
  readonly transition: StateTransition | null;
  readonly trigger: TriggerEvidenceV2 | null;
}
