/**
 * Pure structural validation for v2 strategy definitions. Shared intent: the
 * API enforces these at arm time (alongside Zod shape validation) and the web
 * builder shows them as a pre-save checklist. Codes are stable identifiers the
 * UI maps to friendly copy — messages here are developer-facing defaults.
 */
import { conditionLeaves, referencedTokenIds } from "./compat.js";
import { EXPR_LIMITS } from "./types-v2.js";
import type { ExprNode, StrategyDefinition } from "./types-v2.js";

export interface ValidationIssue {
  readonly code:
    | "EXPR_EMPTY"
    | "EXPR_TOO_DEEP"
    | "EXPR_TOO_MANY_CONDITIONS"
    | "EXPR_TOO_MANY_MARKETS"
    | "NOT_GROUP_ARITY"
    | "GROUP_EMPTY"
    | "PRICE_OUT_OF_RANGE"
    | "THRESHOLD_NOT_POSITIVE"
    | "TIME_WINDOW_INVERTED"
    | "HOLD_WINDOW_OUT_OF_RANGE"
    | "DATA_AGE_OUT_OF_RANGE"
    | "ORDER_PRICE_OUT_OF_RANGE"
    | "ORDER_SIZE_NOT_POSITIVE"
    | "AUTO_REQUIRES_LIMITS"
    | "LIMITS_INCONSISTENT"
    | "LIMITS_NOT_POSITIVE"
    | "ORDER_EXCEEDS_PER_ORDER_CAP"
    | "REPEAT_COUNT_OUT_OF_RANGE"
    | "COOLDOWN_OUT_OF_RANGE"
    | "REPEAT_REQUIRES_ALERT_OR_AUTO"
    | "EXPIRY_IN_PAST";
  readonly message: string;
  /** Node id the issue anchors to, when it concerns a specific node. */
  readonly nodeId: string | null;
}

const MAX_HOLD_MS = 86_400_000; // 1 day (matches v1 continuousWindow cap)
const MAX_DATA_AGE_MS = 60_000;
const MAX_REPEATS = 100;
const MAX_COOLDOWN_MS = 86_400_000;

const depthOf = (node: ExprNode): number =>
  node.type === "condition" ? 1 : 1 + Math.max(0, ...node.children.map(depthOf));

const walkGroups = (
  node: ExprNode,
  fn: (g: Extract<ExprNode, { type: "group" }>) => void,
): void => {
  if (node.type !== "group") return;
  fn(node);
  for (const c of node.children) walkGroups(c, fn);
};

export const validateStrategyDefinition = (
  def: StrategyDefinition,
  nowMs?: number,
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const push = (code: ValidationIssue["code"], message: string, nodeId: string | null = null) =>
    issues.push({ code, message, nodeId });

  // ── Expression shape ──
  const leaves = conditionLeaves(def.expr);
  if (leaves.length === 0) push("EXPR_EMPTY", "Add at least one condition.");
  if (leaves.length > EXPR_LIMITS.maxConditions)
    push(
      "EXPR_TOO_MANY_CONDITIONS",
      `At most ${EXPR_LIMITS.maxConditions} conditions per strategy.`,
    );
  if (depthOf(def.expr) > EXPR_LIMITS.maxDepth)
    push("EXPR_TOO_DEEP", `Logic nesting is limited to ${EXPR_LIMITS.maxDepth} levels.`);
  if (referencedTokenIds(def).length > EXPR_LIMITS.maxMarkets)
    push("EXPR_TOO_MANY_MARKETS", `At most ${EXPR_LIMITS.maxMarkets} markets per strategy.`);

  walkGroups(def.expr, (g) => {
    if (g.op === "not" && g.children.length !== 1)
      push("NOT_GROUP_ARITY", "NOT must wrap exactly one condition or group.", g.id);
    if (g.children.length === 0) push("GROUP_EMPTY", "Empty logic group.", g.id);
  });

  // ── Condition parameters ──
  for (const { id, condition: c } of leaves) {
    switch (c.kind) {
      case "price":
        if (!(c.threshold > 0 && c.threshold < 1))
          push("PRICE_OUT_OF_RANGE", "Price must be between 0¢ and 100¢.", id);
        break;
      case "spread":
        if (!(c.threshold > 0 && c.threshold < 1))
          push("PRICE_OUT_OF_RANGE", "Spread must be between 0¢ and 100¢.", id);
        break;
      case "cumulative_notional":
        if (!(c.priceBound > 0 && c.priceBound < 1))
          push("PRICE_OUT_OF_RANGE", "Price band must be between 0¢ and 100¢.", id);
        if (!(c.minNotional > 0))
          push("THRESHOLD_NOT_POSITIVE", "Liquidity amount must be positive.", id);
        break;
      case "visible_levels":
        if (!(c.priceBound > 0 && c.priceBound < 1))
          push("PRICE_OUT_OF_RANGE", "Price band must be between 0¢ and 100¢.", id);
        if (!(Number.isInteger(c.minLevels) && c.minLevels > 0))
          push("THRESHOLD_NOT_POSITIVE", "Level count must be a positive whole number.", id);
        break;
      case "time_window":
        if (c.startMs !== null && c.endMs !== null && c.startMs >= c.endMs)
          push("TIME_WINDOW_INVERTED", "The time window ends before it starts.", id);
        break;
    }
  }

  // ── Timing ──
  if (!(def.holdsForMs >= 0 && def.holdsForMs <= MAX_HOLD_MS))
    push("HOLD_WINDOW_OUT_OF_RANGE", "Hold duration must be between 0 and 24 hours.");
  if (!(def.maxDataAgeMs > 0 && def.maxDataAgeMs <= MAX_DATA_AGE_MS))
    push("DATA_AGE_OUT_OF_RANGE", "Data freshness must be between 1 and 60 seconds.");
  if (nowMs !== undefined && def.expiresAtMs !== null && def.expiresAtMs <= nowMs)
    push("EXPIRY_IN_PAST", "The expiry time is already in the past.");

  // ── Action ──
  if (def.action.kind === "order") {
    const a = def.action;
    if (!(a.price > 0 && a.price < 1))
      push("ORDER_PRICE_OUT_OF_RANGE", "Order price must be between 0¢ and 100¢.");
    if (!(a.size > 0)) push("ORDER_SIZE_NOT_POSITIVE", "Order size must be positive.");

    if (a.execution === "auto") {
      if (def.limits === null) {
        push("AUTO_REQUIRES_LIMITS", "Auto mode requires spending limits before arming.");
      } else {
        const l = def.limits;
        if (!(l.maxNotionalPerOrder > 0 && l.maxTotalNotional > 0 && l.maxDailyNotional > 0))
          push("LIMITS_NOT_POSITIVE", "Spending limits must be positive.");
        if (l.maxNotionalPerOrder > l.maxDailyNotional || l.maxDailyNotional > l.maxTotalNotional)
          push("LIMITS_INCONSISTENT", "Limits must satisfy per-order ≤ daily ≤ total.");
        const orderNotional = a.price * a.size;
        if (orderNotional > l.maxNotionalPerOrder)
          push(
            "ORDER_EXCEEDS_PER_ORDER_CAP",
            "The order's cost exceeds the per-order spending limit.",
          );
      }
    }
  }

  // ── Recurrence ──
  if (def.recurrence.kind === "repeat") {
    const r = def.recurrence;
    if (!(Number.isInteger(r.maxRepeats) && r.maxRepeats >= 2 && r.maxRepeats <= MAX_REPEATS))
      push("REPEAT_COUNT_OUT_OF_RANGE", `Repeat count must be between 2 and ${MAX_REPEATS}.`);
    if (!(r.cooldownMs >= 0 && r.cooldownMs <= MAX_COOLDOWN_MS))
      push("COOLDOWN_OUT_OF_RANGE", "Cooldown must be between 0 and 24 hours.");
    const prepared = def.action.kind === "order" && def.action.execution === "prepare";
    if (prepared)
      push(
        "REPEAT_REQUIRES_ALERT_OR_AUTO",
        "Repeat works with alerts or auto execution — signed orders trigger once.",
      );
  }

  return issues;
};
