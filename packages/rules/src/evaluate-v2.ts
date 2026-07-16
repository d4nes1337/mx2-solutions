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
  priceMove,
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
  TrailingWatermark,
  ViewsByToken,
  WatermarksByNode,
} from "./types-v2.js";

/**
 * Mutable collector for the NEXT watermark map, threaded through one
 * evaluation pass. The evaluator stays pure from the outside: `prev` is never
 * mutated and `next` is a fresh object per call.
 */
interface WatermarkPass {
  readonly prev: WatermarksByNode;
  readonly next: Record<string, TrailingWatermark>;
}

/** Effective trigger level for a trailing condition at a given watermark. */
const watermarkTrigger = (
  c: Extract<ConditionV2, { kind: "trailing" }>,
  watermark: number,
): number => (c.mode === "stop" ? watermark - c.offset : watermark + c.offset);

/**
 * Float tolerance for trigger-level comparisons: `watermark ± offset` is
 * computed (0.6 − 0.05 = 0.549999…), so an exact-boundary tick must still
 * count. Minimum price tick is 0.0001 — 1e-9 can never flip a real level.
 */
export const TRAILING_EPS = 1e-9;

const evalCondition = (
  c: ConditionV2,
  nodeId: string,
  views: ViewsByToken,
  nowMs: number,
  maxDataAgeMs: number,
  wm: WatermarkPass,
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

  if (c.kind === "trailing") {
    const prior = wm.prev[nodeId];
    // Fail-closed AND frozen: stale/missing data can neither satisfy the
    // condition nor move the watermark — but it must not erase it either.
    if (prior !== undefined) wm.next[nodeId] = prior;
    const ref = view ? (c.source === "ask" ? bestAsk(view) : bestBid(view)) : null;
    if (!view || stale || ref === null) {
      // threshold 0 = "no trigger level yet" (NaN would break JSON round-trips).
      return {
        ...fail("trailing", prior !== undefined ? watermarkTrigger(c, prior.value) : 0),
        watermark: prior?.value ?? null,
      };
    }
    // Update-then-check: the observation first ratchets the watermark, then
    // the trigger level is measured against the SAME observation.
    const value =
      prior === undefined
        ? ref
        : c.mode === "stop"
          ? Math.max(prior.value, ref)
          : Math.min(prior.value, ref);
    wm.next[nodeId] = {
      value,
      armedAtMs: prior?.armedAtMs ?? nowMs,
      updatedAtMs: prior === undefined || value !== prior.value ? nowMs : prior.updatedAtMs,
    };
    const trigger = watermarkTrigger(c, value);
    // The arming observation never satisfies (offset > 0 by validation).
    const satisfied =
      prior !== undefined &&
      (c.mode === "stop" ? ref <= trigger + TRAILING_EPS : ref >= trigger - TRAILING_EPS);
    return {
      kind: "trailing",
      satisfied,
      actual: ref,
      threshold: trigger,
      reason: prior === undefined ? "TRAILING_ARMING" : satisfied ? "TRAILING_OK" : "TRAILING_FAIL",
      tokenId: c.market.tokenId,
      stale: false,
      watermark: value,
    };
  }

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
    case "price_move": {
      if (!view) return fail("price_move", c.deltaThreshold);
      const move = priceMove(view, c.windowMs, nowMs);
      // Incomplete window coverage is treated as staleness: unsatisfied AND
      // stale, so the global fail-closed override protects NOT(price_move)
      // from firing on missing data.
      if (move === null) {
        return {
          kind: "price_move",
          satisfied: false,
          actual: null,
          threshold: c.deltaThreshold,
          reason: "PRICE_MOVE_WINDOW_INCOMPLETE",
          tokenId: c.market.tokenId,
          stale: true,
        };
      }
      const actual =
        c.direction === "drop"
          ? move.drop
          : c.direction === "rise"
            ? move.rise
            : Math.max(move.drop, move.rise);
      const satisfied = !stale && actual >= c.deltaThreshold;
      return {
        kind: "price_move",
        satisfied,
        actual,
        threshold: c.deltaThreshold,
        reason: stale ? "DATA_STALE" : satisfied ? "PRICE_MOVE_OK" : "PRICE_MOVE_FAIL",
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
  wm: WatermarkPass,
): ExprResultNode => {
  if (node.type === "condition") {
    const result = evalCondition(node.condition, node.id, views, nowMs, maxDataAgeMs, wm);
    return { type: "condition", id: node.id, satisfied: result.satisfied, result };
  }
  const children = node.children.map((c) => evalNode(c, views, nowMs, maxDataAgeMs, wm));
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
 *
 * `watermarksIn` carries trailing-condition state from the previous
 * observation (StrategyRuntime.watermarks); the returned `watermarks` map is
 * the updated state to persist. The input is never mutated. Callers that
 * evaluate statelessly (draft evaluation) omit it — trailing conditions then
 * report "arming" on every pass, which is the honest stateless answer.
 */
export const evaluateExpression = (
  def: StrategyDefinition,
  views: ViewsByToken,
  nowMs: number,
  watermarksIn: WatermarksByNode = {},
): EvaluationV2 => {
  const wm: WatermarkPass = { prev: watermarksIn, next: {} };
  const root = evalNode(def.expr, views, nowMs, def.maxDataAgeMs, wm);
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

  return { satisfied, root, reasonCodes, staleTokenIds, watermarks: wm.next };
};
