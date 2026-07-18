/**
 * Builder document model. A StrategyDoc is the single source of truth the
 * canvas, the chip sentence and the advanced drawer all project from. It is
 * the engine's StrategyDefinition plus editor-only metadata (node positions,
 * selection, market display names) that never leaves the browser.
 */
import { EXPR_LIMITS, depthOf } from "@mx2/rules";
import type {
  ActionV2,
  ConditionV2,
  ExprNode,
  GroupNode,
  MarketRef,
  RecurrenceV2,
  StrategyDefinition,
  StrategyLimits,
} from "@mx2/rules";

export interface NodePosition {
  x: number;
  y: number;
  /** Manual node size (NodeResizer / expand button). Unset = auto/compact. */
  w?: number;
  h?: number;
}

/** Display metadata for a referenced market (titles come from search/binding). */
export interface MarketMeta {
  title: string;
  eventTitle?: string;
  image?: string;
  /** Maker-rewards program params captured at bind time (Gamma, A-050). */
  rewardsMinSize?: number | null;
  rewardsMaxSpread?: number | null;
}

export interface StrategyDoc {
  name: string;
  templateId: string | null;
  /** The root is always a group; its op is the top-level ALL-OF / ANY-OF. */
  expr: GroupNode;
  holdsForMs: number;
  maxDataAgeMs: number;
  action: ActionV2;
  recurrence: RecurrenceV2;
  limits: StrategyLimits | null;
  expiresAtMs: number | null;
  // ── Editor-only (stripped by compile) ──
  positions: Record<string, NodePosition>;
  selectedNodeId: string | null;
  marketMeta: Record<string, MarketMeta>;
  /**
   * Markets added to the canvas (toolbar search) that no condition references
   * yet — they render as market nodes so conditions can be bound to them.
   */
  watchedMarkets: MarketRef[];
}

/** Placeholder for a condition the user hasn't bound to a market yet. */
export const UNBOUND: MarketRef = { conditionId: "", tokenId: "", outcome: "YES" };

/** True when the doc holds anything worth keeping (gates draft persistence). */
export const docHasContent = (doc: StrategyDoc): boolean =>
  doc.expr.children.length > 0 ||
  doc.watchedMarkets.length > 0 ||
  doc.name.trim() !== "" ||
  doc.action.kind !== "alert";

export const isBound = (m: MarketRef): boolean => m.tokenId !== "" && m.conditionId !== "";

export const emptyDoc = (): StrategyDoc => ({
  name: "",
  templateId: null,
  expr: { type: "group", id: "root", op: "and", children: [] },
  holdsForMs: 300_000,
  maxDataAgeMs: 30_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  positions: {},
  selectedNodeId: null,
  marketMeta: {},
  watchedMarkets: [],
});

// ── Pure tree helpers ────────────────────────────────────────────────────────

let nextId = 1;
/** Unique-enough node ids for a single editing session. */
export const freshNodeId = (prefix = "c"): string =>
  `${prefix}${Date.now().toString(36)}${nextId++}`;

export const findNode = (node: ExprNode, id: string): ExprNode | null => {
  if (node.id === id) return node;
  if (node.type !== "group") return null;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};

/** Remove a node anywhere below the root; unwraps NOT groups left empty. */
export const removeNodeFromTree = (root: GroupNode, id: string): GroupNode => {
  const strip = (node: ExprNode): ExprNode | null => {
    if (node.id === id) return null;
    if (node.type !== "group") return node;
    const children = node.children.map(strip).filter((c): c is ExprNode => c !== null);
    if (node.id !== "root" && children.length === 0) return null;
    return { ...node, children };
  };
  const out = strip(root);
  return out && out.type === "group" ? out : { ...root, children: [] };
};

/**
 * Move a node under a new parent, preserving its identity (id, and therefore
 * canvas positions/selection/eval-result identity). Returns the SAME root
 * reference when the move is refused, so callers can detect a no-op.
 * Guards: no root/self moves; target must exist and be an AND/OR group (NOT
 * groups are single-child wrappers) or "root"; no moving a group into its own
 * subtree; depth must stay within EXPR_LIMITS after the move. The emptied
 * source group auto-collapses via removeNodeFromTree.
 */
export const moveNodeInTree = (root: GroupNode, id: string, newParentId: string): GroupNode => {
  if (id === "root" || id === newParentId) return root;
  const moved = findNode(root, id);
  if (!moved) return root;

  const targetNode = newParentId === "root" ? root : findNode(root, newParentId);
  if (!targetNode || targetNode.type !== "group" || targetNode.op === "not") return root;
  // No-op when already a direct child of the target.
  if (targetNode.children.some((c) => c.id === id)) return root;
  // A group can't move into its own subtree.
  if (moved.type === "group" && findNode(moved, newParentId) !== null) return root;

  // Detach, collapsing groups the move emptied — but NEVER the target group
  // itself (an empty ANY-OF/ALL-OF group from the palette IS a valid target).
  const strip = (node: ExprNode): ExprNode | null => {
    if (node.id === id) return null;
    if (node.type !== "group") return node;
    const children = node.children.map(strip).filter((c): c is ExprNode => c !== null);
    if (node.id !== "root" && node.id !== newParentId && children.length === 0) return null;
    return { ...node, children };
  };
  const strippedRaw = strip(root);
  const stripped = strippedRaw && strippedRaw.type === "group" ? strippedRaw : root;
  const survivingTarget = newParentId === "root" ? stripped : findNode(stripped, newParentId);
  if (!survivingTarget || survivingTarget.type !== "group") return root;

  const inserted = replaceNodeInTree(stripped, survivingTarget.id, {
    ...survivingTarget,
    children: [...survivingTarget.children, moved],
  });
  if (depthOf(inserted) > EXPR_LIMITS.maxDepth) return root;
  return inserted;
};

export const replaceNodeInTree = (root: GroupNode, id: string, next: ExprNode): GroupNode => {
  const swap = (node: ExprNode): ExprNode => {
    if (node.id === id) return next;
    if (node.type !== "group") return node;
    return { ...node, children: node.children.map(swap) };
  };
  const out = swap(root);
  return out.type === "group" ? out : root;
};

/** Wrap a node in a NOT group, or unwrap it if its parent is a NOT group. */
export const toggleNotInTree = (root: GroupNode, id: string): GroupNode => {
  // Unwrap: the node's parent is a single-child NOT group.
  const unwrap = (node: ExprNode): ExprNode => {
    if (node.type === "group") {
      if (node.op === "not" && node.children.length === 1 && node.children[0]!.id === id) {
        return node.children[0]!;
      }
      return { ...node, children: node.children.map(unwrap) };
    }
    return node;
  };
  const unwrapped = unwrap(root);
  if (JSON.stringify(unwrapped) !== JSON.stringify(root)) {
    return unwrapped.type === "group" ? unwrapped : root;
  }
  // Wrap.
  const target = findNode(root, id);
  if (!target || id === "root") return root;
  return replaceNodeInTree(root, id, {
    type: "group",
    id: freshNodeId("n"),
    op: "not",
    children: [target],
  });
};

export const conditionLeavesOf = (
  node: ExprNode,
): { id: string; condition: ConditionV2; negated: boolean }[] => {
  const walk = (
    n: ExprNode,
    negated: boolean,
  ): { id: string; condition: ConditionV2; negated: boolean }[] => {
    if (n.type === "condition") return [{ id: n.id, condition: n.condition, negated }];
    return n.children.flatMap((c) => walk(c, negated !== (n.op === "not")));
  };
  return walk(node, false);
};

/**
 * Every distinct market the doc references (conditions + order action), plus
 * canvas-watched markets nothing references yet.
 */
export const docMarketRefs = (doc: StrategyDoc): MarketRef[] => {
  const seen = new Map<string, MarketRef>();
  for (const { condition } of conditionLeavesOf(doc.expr)) {
    if (condition.kind !== "time_window" && isBound(condition.market)) {
      seen.set(condition.market.tokenId, condition.market);
    }
  }
  if (doc.action.kind === "order" && isBound(doc.action.market)) {
    seen.set(doc.action.market.tokenId, doc.action.market);
  }
  for (const ref of doc.watchedMarkets) {
    if (!seen.has(ref.tokenId)) seen.set(ref.tokenId, ref);
  }
  return [...seen.values()];
};

/** True when a condition or the order action references this token. */
export const isTokenReferenced = (doc: StrategyDoc, tokenId: string): boolean => {
  for (const { condition } of conditionLeavesOf(doc.expr)) {
    if (condition.kind !== "time_window" && condition.market.tokenId === tokenId) return true;
  }
  return doc.action.kind === "order" && doc.action.market.tokenId === tokenId;
};

/** Short display label for a market reference. */
export const marketLabel = (doc: StrategyDoc, ref: MarketRef): string => {
  if (!isBound(ref)) return "pick a market";
  const title = doc.marketMeta[ref.tokenId]?.title ?? ref.title;
  if (title) return title.length > 48 ? `${title.slice(0, 45)}…` : title;
  return `${ref.tokenId.slice(0, 6)}…`;
};

/**
 * Rehydrate a builder doc from a stored definition (edit flow, monitor cards).
 * Root is coerced to a group so hand-crafted single-condition definitions
 * still open in the builder.
 */
export const docFromDefinition = (def: StrategyDefinition): StrategyDoc => ({
  name: def.name,
  templateId: def.templateId,
  expr:
    def.expr.type === "group"
      ? { ...def.expr, id: "root" }
      : { type: "group", id: "root", op: "and", children: [def.expr] },
  holdsForMs: def.holdsForMs,
  maxDataAgeMs: def.maxDataAgeMs,
  action: def.action,
  recurrence: def.recurrence,
  limits: def.limits,
  expiresAtMs: def.expiresAtMs,
  positions: {},
  selectedNodeId: null,
  marketMeta: {},
  watchedMarkets: [],
});

export type StrategyDefinitionInput = Omit<StrategyDefinition, "version">;
