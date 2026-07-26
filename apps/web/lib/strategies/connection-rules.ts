/**
 * Pure legality rules for user-drawn canvas connections and drop-to-bind
 * gestures. Kept out of BuilderCanvas so every verdict (and its human reason)
 * is unit-testable without React Flow.
 *
 * Handle vocabulary (nodes.tsx): markets emit from `m-out`; conditions accept
 * markets on `m-in` and emit tree edges from `t-out`; groups/root accept tree
 * edges on `t-in` and emit from `t-out`; the action accepts the fixed root
 * edge on `t-in` and market bindings on `m-in` (order actions only).
 */
import { findNode, moveNodeInTree, type StrategyDoc } from "./doc";

export type ConnectionVerdict = { ok: true } | { ok: false; reason: string };

export interface ConnectionLike {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

const marketToken = (nodeId: string | null): string | null =>
  nodeId && nodeId.startsWith("market:") ? nodeId.slice("market:".length) : null;

export const validateConnection = (doc: StrategyDoc, c: ConnectionLike): ConnectionVerdict => {
  const { source, target } = c;
  if (!source || !target) return { ok: false, reason: "Incomplete connection." };

  const sourceToken = marketToken(source);

  // Market → something: a binding gesture.
  if (sourceToken !== null) {
    if (target === "action") {
      if (doc.action.kind === "order") return { ok: true };
      if (doc.action.kind === "quote_loop") {
        return { ok: false, reason: "Farm loops carry their own market — nothing to bind here." };
      }
      return { ok: false, reason: "Only order actions trade a market — switch the action first." };
    }
    const node = findNode(doc.expr, target);
    if (!node || node.type !== "condition") {
      return { ok: false, reason: "Markets connect to conditions or the order action." };
    }
    if (node.condition.kind === "time_window") {
      return { ok: false, reason: "Time windows don't watch a market." };
    }
    return { ok: true };
  }

  // Tree gesture: condition/group → group/root.
  if (marketToken(target) !== null) {
    return { ok: false, reason: "Connect FROM the market's right side to a condition." };
  }
  if (source === "action") return { ok: false, reason: "The action is the end of the flow." };
  if (source === "root") {
    return { ok: false, reason: "The trigger is already connected to the action." };
  }
  if (target === "action") {
    return { ok: false, reason: "Only the trigger logic connects to the action." };
  }

  const moved = findNode(doc.expr, source);
  if (!moved) return { ok: false, reason: "Unknown block." };
  const targetNode = target === "root" ? doc.expr : findNode(doc.expr, target);
  if (!targetNode || targetNode.type !== "group") {
    return { ok: false, reason: "Blocks join ALL-OF / ANY-OF groups (or the trigger)." };
  }
  if (targetNode.op === "not") {
    return { ok: false, reason: "NOT wraps exactly one block — use the block's NOT button." };
  }
  // Delegate the full legality check (own subtree, depth, no-op) to the move
  // primitive: same-reference result = refusal.
  if (moveNodeInTree(doc.expr, source, target) === doc.expr) {
    if (targetNode.children.some((ch) => ch.id === source)) {
      return { ok: false, reason: "Already inside this group." };
    }
    return { ok: false, reason: "That nesting would be too deep (max 3 levels)." };
  }
  return { ok: true };
};

/**
 * First valid bind target among the nodes a dragged market block overlaps:
 * a non-time_window condition id, "action" (order actions only), or null.
 */
export const dropTargetFor = (
  doc: StrategyDoc,
  draggedMarketTokenId: string,
  intersectingNodeIds: readonly string[],
): string | null => {
  for (const id of intersectingNodeIds) {
    if (id === "action") {
      if (doc.action.kind === "order") return "action";
      continue;
    }
    if (id === "root" || id.startsWith("market:")) continue;
    const node = findNode(doc.expr, id);
    if (node?.type === "condition" && node.condition.kind !== "time_window") return id;
  }
  return null;
};
