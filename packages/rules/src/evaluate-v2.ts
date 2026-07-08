/**
 * Pure v2 expression evaluation over multiple market views (ADR-0010).
 *
 * Fail-closed staleness (deliberately conservative): if ANY market referenced
 * anywhere in the expression is missing or older than maxDataAgeMs, the whole
 * expression is unsatisfied — even inside an OR whose other branch is fresh
 * and true. Leaves are still individually evaluated so the builder's live view
 * can show per-condition state, with `stale` marking the unusable inputs.
 */
import {
  bestAsk,
  bestBid,
  cumulativeNotional,
  dataAgeMs,
  spread,
  visibleLevels,
} from "./predicates.js";
import { conditionLeaves } from "./compat.js";
import type { MarketDataView, ReasonCode } from "./types.js";
import type {
  ConditionResultV2,
  ConditionV2,
  EvaluationV2,
  ExprNode,
  ExprResultNode,
  StrategyDefinition,
  ViewsByToken,
} from "./types-v2.js";

const evalCondition = (
  c: ConditionV2,
  views: ViewsByToken,
  nowMs: number,
  maxDataAgeMs: number,
): ConditionResultV2 => {
  if (c.kind === "time_window") {
    const satisfied =
      (c.startMs === null || nowMs >= c.startMs) && (c.endMs === null || nowMs <= c.endMs);
    return {
      kind: "time_window",
      satisfied,
      actual: nowMs,
      threshold: c.startMs ?? c.endMs ?? 0,
      reason: satisfied ? "TIME_WINDOW_OK" : "TIME_WINDOW_FAIL",
      tokenId: null,
      stale: false,
    };
  }

  const view: MarketDataView | undefined = views[c.market.tokenId];
  const stale = !view || dataAgeMs(view, nowMs) > maxDataAgeMs;

  const fail = (kind: ConditionResultV2["kind"], threshold: number): ConditionResultV2 => ({
    kind,
    satisfied: false,
    actual: null,
    threshold,
    reason: "DATA_STALE",
    tokenId: c.market.tokenId,
    stale: true,
  });

  switch (c.kind) {
    case "price": {
      if (!view) return fail("price", c.threshold);
      const actual = c.source === "ask" ? bestAsk(view) : bestBid(view);
      const satisfied =
        !stale &&
        actual !== null &&
        (c.comparator === "lte" ? actual <= c.threshold : actual >= c.threshold);
      return {
        kind: "price",
        satisfied,
        actual,
        threshold: c.threshold,
        reason: stale ? "DATA_STALE" : satisfied ? "PRICE_OK" : "PRICE_FAIL",
        tokenId: c.market.tokenId,
        stale,
      };
    }
    case "spread": {
      if (!view) return fail("spread", c.threshold);
      const actual = spread(view);
      const satisfied =
        !stale &&
        actual !== null &&
        (c.comparator === "lte" ? actual <= c.threshold : actual >= c.threshold);
      return {
        kind: "spread",
        satisfied,
        actual,
        threshold: c.threshold,
        reason: stale ? "DATA_STALE" : satisfied ? "SPREAD_OK" : "SPREAD_FAIL",
        tokenId: c.market.tokenId,
        stale,
      };
    }
    case "cumulative_notional": {
      if (!view) return fail("cumulative_notional", c.minNotional);
      const actual = cumulativeNotional(view, c.source, c.priceBound);
      const satisfied = !stale && actual >= c.minNotional;
      return {
        kind: "cumulative_notional",
        satisfied,
        actual,
        threshold: c.minNotional,
        reason: stale ? "DATA_STALE" : satisfied ? "NOTIONAL_OK" : "NOTIONAL_FAIL",
        tokenId: c.market.tokenId,
        stale,
      };
    }
    case "visible_levels": {
      if (!view) return fail("visible_levels", c.minLevels);
      const actual = visibleLevels(view, c.source, c.priceBound);
      const satisfied = !stale && actual >= c.minLevels;
      return {
        kind: "visible_levels",
        satisfied,
        actual,
        threshold: c.minLevels,
        reason: stale ? "DATA_STALE" : satisfied ? "LEVELS_OK" : "LEVELS_FAIL",
        tokenId: c.market.tokenId,
        stale,
      };
    }
  }
};

const evalNode = (
  node: ExprNode,
  views: ViewsByToken,
  nowMs: number,
  maxDataAgeMs: number,
): ExprResultNode => {
  if (node.type === "condition") {
    const result = evalCondition(node.condition, views, nowMs, maxDataAgeMs);
    return { type: "condition", id: node.id, satisfied: result.satisfied, result };
  }
  const children = node.children.map((c) => evalNode(c, views, nowMs, maxDataAgeMs));
  let satisfied: boolean;
  switch (node.op) {
    case "and":
      satisfied = children.length > 0 && children.every((c) => c.satisfied);
      break;
    case "or":
      satisfied = children.some((c) => c.satisfied);
      break;
    case "not":
      satisfied = children.length === 1 && !children[0]!.satisfied;
      break;
  }
  return { type: "group", id: node.id, op: node.op, satisfied, children };
};

const collectResults = (node: ExprResultNode): readonly ConditionResultV2[] =>
  node.type === "condition" ? [node.result] : node.children.flatMap(collectResults);

/**
 * Evaluate the strategy's expression against the views available at `nowMs`.
 * Root satisfaction is fail-closed on staleness: any referenced market with
 * missing/stale data forces `satisfied: false` regardless of tree shape.
 */
export const evaluateExpression = (
  def: StrategyDefinition,
  views: ViewsByToken,
  nowMs: number,
): EvaluationV2 => {
  const root = evalNode(def.expr, views, nowMs, def.maxDataAgeMs);
  const results = collectResults(root);

  const staleTokenIds = [
    ...new Set(results.filter((r) => r.stale && r.tokenId !== null).map((r) => r.tokenId!)),
  ];
  const anyStale = staleTokenIds.length > 0;
  // NOT groups could turn a stale (unsatisfied) leaf into a satisfied branch,
  // so staleness must override the tree verdict, not just flow through it.
  const satisfied = !anyStale && root.satisfied && conditionLeaves(def.expr).length > 0;

  const reasonCodes: ReasonCode[] = results.map((r) => r.reason);
  if (anyStale && !reasonCodes.includes("DATA_STALE")) reasonCodes.push("DATA_STALE");

  return { satisfied, root, reasonCodes, staleTokenIds };
};
