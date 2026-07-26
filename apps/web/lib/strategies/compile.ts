/**
 * Doc → API definition + pre-save validation. Structural/limit checks reuse
 * the engine's validator (the same one the API runs at arm time), extended
 * with builder-only issues like unbound market references.
 */
import { validateStrategyDefinition, type StrategyDefinition } from "@mx2/rules";
import { conditionLeavesOf, isBound, type StrategyDoc } from "./doc";

export interface BuilderIssue {
  code: string;
  message: string;
  nodeId: string | null;
}

/** Strip editor metadata; what remains is exactly the API's create payload. */
export const compileDoc = (doc: StrategyDoc): StrategyDefinition => ({
  version: 2,
  name: doc.name.trim() || "Untitled Smart Order",
  templateId: doc.templateId,
  expr: doc.expr,
  holdsForMs: doc.holdsForMs,
  maxDataAgeMs: doc.maxDataAgeMs,
  action: doc.action,
  recurrence: doc.recurrence,
  limits: doc.limits,
  expiresAtMs: doc.expiresAtMs,
});

/** Friendly copy for engine validation codes (falls back to engine message). */
const FRIENDLY: Record<string, string> = {
  EXPR_EMPTY: "Add at least one condition to watch.",
  EXPR_TOO_DEEP: "Logic is nested too deeply — flatten a group.",
  EXPR_TOO_MANY_CONDITIONS: "Too many conditions — split this into two Smart Orders.",
  EXPR_TOO_MANY_MARKETS: "A Smart Order can watch at most 4 markets.",
  AUTO_REQUIRES_LIMITS: "Set spending limits before arming auto mode.",
  LIMITS_INCONSISTENT: "Spending limits must satisfy per-order ≤ daily ≤ total.",
  ORDER_EXCEEDS_PER_ORDER_CAP: "The order costs more than your per-order limit.",
  REPEAT_REQUIRES_ALERT_OR_AUTO:
    "Repeat works with alerts or auto mode — signed orders trigger once.",
};

export const validateDoc = (doc: StrategyDoc, nowMs = Date.now()): BuilderIssue[] => {
  const issues: BuilderIssue[] = [];

  // Builder-only: every market-bound condition (and an order action) must be
  // bound to a real market before saving.
  for (const { id, condition } of conditionLeavesOf(doc.expr)) {
    if (condition.kind !== "time_window" && !isBound(condition.market)) {
      issues.push({
        code: "MARKET_UNBOUND",
        message: "Pick a market for this condition.",
        nodeId: id,
      });
    }
  }
  if (doc.action.kind === "order" && !isBound(doc.action.market)) {
    issues.push({
      code: "MARKET_UNBOUND",
      message: "Pick the market this order trades.",
      nodeId: "action",
    });
  }

  for (const issue of validateStrategyDefinition(compileDoc(doc), nowMs)) {
    issues.push({
      code: issue.code,
      message: FRIENDLY[issue.code] ?? issue.message,
      nodeId: issue.nodeId,
    });
  }
  return issues;
};
