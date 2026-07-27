/**
 * Pure quick-edit surgery on an (immutable) StrategyDefinition: the NUMBERS at
 * every joint of the strategy — each condition's own threshold/offset/window,
 * the order's limit price and size, and the root hold window — returning a
 * fresh definition ready for the supersede flow.
 *
 * Deliberately NOT here: anything structural (adding/removing conditions or
 * markets, AND/OR rewiring, action kind, spend caps, recurrence). Those change
 * what the strategy IS, so they belong in the builder, not a side panel.
 */
import type { ConditionV2, ExprNode, StrategyDefinition } from "@mx2/rules";

/** Every per-condition number the panel can tune, keyed by ConditionNode id. */
export interface DefinitionEdits {
  /** price.threshold AND spread.threshold (0–1 probability). */
  thresholds?: Record<string, number>;
  /** trailing.offset (0–1 probability). */
  offsets?: Record<string, number>;
  /** price_move.deltaThreshold (0–1 probability). */
  deltas?: Record<string, number>;
  /** price_move.windowMs. */
  windows?: Record<string, number>;
  /** cumulative_notional.minNotional (USD). */
  minNotionals?: Record<string, number>;
  /** visible_levels.minLevels (count). */
  minLevels?: Record<string, number>;
  /** Order action limit price (0–1 probability). */
  orderPrice?: number;
  /** Order action size in shares. */
  orderSize?: number;
  /** Root hold window in ms. */
  holdsForMs?: number;
}

/** True when the edit set carries at least one per-condition change. */
const hasConditionEdits = (e: DefinitionEdits): boolean =>
  [e.thresholds, e.offsets, e.deltas, e.windows, e.minNotionals, e.minLevels].some(
    (m) => m !== undefined && Object.keys(m).length > 0,
  );

const mapConditions = (
  node: ExprNode,
  fn: (id: string, c: ConditionV2) => ConditionV2,
): ExprNode => {
  if (node.type === "condition") {
    const next = fn(node.id, node.condition);
    return next === node.condition ? node : { ...node, condition: next };
  }
  return { ...node, children: node.children.map((child) => mapConditions(child, fn)) };
};

/** Apply the staged number(s) for one condition, matched to its kind. */
const patchCondition = (id: string, c: ConditionV2, edits: DefinitionEdits): ConditionV2 => {
  switch (c.kind) {
    case "price":
    case "spread": {
      const next = edits.thresholds?.[id];
      return next === undefined ? c : { ...c, threshold: next };
    }
    case "trailing": {
      const next = edits.offsets?.[id];
      return next === undefined ? c : { ...c, offset: next };
    }
    case "price_move": {
      const delta = edits.deltas?.[id];
      const window = edits.windows?.[id];
      if (delta === undefined && window === undefined) return c;
      return {
        ...c,
        ...(delta !== undefined ? { deltaThreshold: delta } : {}),
        ...(window !== undefined ? { windowMs: window } : {}),
      };
    }
    case "cumulative_notional": {
      const next = edits.minNotionals?.[id];
      return next === undefined ? c : { ...c, minNotional: next };
    }
    case "visible_levels": {
      const next = edits.minLevels?.[id];
      return next === undefined ? c : { ...c, minLevels: next };
    }
    case "time_window":
      return c; // exact timestamps stay in the builder
  }
};

export const applyDefinitionEdits = (
  def: StrategyDefinition,
  edits: DefinitionEdits,
): StrategyDefinition => {
  const expr = hasConditionEdits(edits)
    ? mapConditions(def.expr, (id, c) => patchCondition(id, c, edits))
    : def.expr;
  const action =
    def.action.kind === "order" && (edits.orderPrice !== undefined || edits.orderSize !== undefined)
      ? {
          ...def.action,
          ...(edits.orderPrice !== undefined ? { price: edits.orderPrice } : {}),
          ...(edits.orderSize !== undefined ? { size: edits.orderSize } : {}),
        }
      : def.action;
  return {
    ...def,
    expr,
    action,
    ...(edits.holdsForMs !== undefined ? { holdsForMs: edits.holdsForMs } : {}),
  };
};
