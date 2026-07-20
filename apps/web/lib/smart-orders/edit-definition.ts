/**
 * Pure quick-edit surgery on an (immutable) StrategyDefinition: swap price
 * thresholds by condition node id and/or the order's limit price/size,
 * returning a fresh definition ready for the supersede flow. Everything else
 * — windows, offsets, caps, recurrence — stays exactly as stored; the full
 * editors own those.
 */
import type { ConditionV2, ExprNode, StrategyDefinition } from "@mx2/rules";

export interface DefinitionEdits {
  /** Price-condition thresholds by ConditionNode id (0–1 probability). */
  thresholds?: Record<string, number>;
  /** Order action limit price (0–1 probability). */
  orderPrice?: number;
  /** Order action size in shares. */
  orderSize?: number;
}

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

export const applyDefinitionEdits = (
  def: StrategyDefinition,
  edits: DefinitionEdits,
): StrategyDefinition => {
  const thresholds = edits.thresholds ?? {};
  const expr =
    Object.keys(thresholds).length > 0
      ? mapConditions(def.expr, (id, c) => {
          const next = thresholds[id];
          return next !== undefined && c.kind === "price" ? { ...c, threshold: next } : c;
        })
      : def.expr;
  const action =
    def.action.kind === "order" && (edits.orderPrice !== undefined || edits.orderSize !== undefined)
      ? {
          ...def.action,
          ...(edits.orderPrice !== undefined ? { price: edits.orderPrice } : {}),
          ...(edits.orderSize !== undefined ? { size: edits.orderSize } : {}),
        }
      : def.action;
  return { ...def, expr, action };
};
