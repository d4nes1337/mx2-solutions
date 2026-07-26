/**
 * Grid projection — the second projection of a StrategyDoc (ADR-0010: the doc
 * is the single source of truth; the canvas and this grid are both pure views
 * over it). The grid renders the common shape directly: a root ALL/ANY over
 * per-market cards, where each card may carry its own ALL/ANY when it holds
 * more than one condition (a real two-level expression tree, depth 2).
 *
 * Anything the grid cannot faithfully EDIT — NOT groups, nested groups,
 * groups mixing markets — is classified as `complex` and must be rendered
 * read-only with an "open canvas" affordance. The grid never silently
 * flattens logic: every root child is classified exactly once as a card row,
 * a card-backing group, or a complex group (the coverage invariant).
 */
import type { ConditionV2, ExprNode, ExprResultNode, GroupNode, MarketRef } from "@mx2/rules";
import { isBound, type StrategyDoc } from "./doc";

export interface GridRow {
  nodeId: string;
  condition: ConditionV2;
}

export interface WatchCard {
  /** tokenId, or "time" (time-window pseudo-card), or "unbound" (placeholder). */
  key: string;
  /** null for the time pseudo-card and the unbound placeholder. */
  market: MarketRef | null;
  rows: GridRow[];
  /**
   * Effective combinator among this card's rows. When the rows sit flat on
   * the root (opNodeId === null) it mirrors the root op; a real per-market
   * group carries its own op.
   */
  op: "and" | "or";
  /** The per-market GroupNode backing this card, or null when rows sit flat. */
  opNodeId: string | null;
  /** Editor-only: an unreferenced watched market renders as an empty card. */
  placeholder: boolean;
}

/** A root child the grid can render but not edit (NOT / nested / mixed markets). */
export interface ComplexGroup {
  node: GroupNode;
}

export interface GridProjection {
  rootOp: "and" | "or";
  watch: WatchCard[];
  /** Conditions bound to the order's target market — shown in the ACT zone. */
  guards: GridRow[];
  guardsOp: "and" | "or";
  guardsOpNodeId: string | null;
  complex: ComplexGroup[];
}

const TIME_KEY = "time";
const UNBOUND_KEY = "unbound";

const conditionKey = (c: ConditionV2): string => {
  if (c.kind === "time_window") return TIME_KEY;
  return isBound(c.market) ? c.market.tokenId : UNBOUND_KEY;
};

const conditionMarket = (c: ConditionV2): MarketRef | null =>
  c.kind === "time_window" ? null : isBound(c.market) ? c.market : null;

/**
 * A root-child group qualifies as a per-market card iff it is a plain AND/OR
 * whose children are all condition leaves sharing one card key. Everything
 * else is complex.
 */
const qualifiesAsCard = (g: GroupNode): string | null => {
  if (g.op === "not" || g.children.length === 0) return null;
  let key: string | null = null;
  for (const child of g.children) {
    if (child.type !== "condition") return null;
    const k = conditionKey(child.condition);
    if (key === null) key = k;
    else if (key !== k) return null;
  }
  return key;
};

export const docToGrid = (doc: StrategyDoc): GridProjection => {
  const root = doc.expr;
  const rootOp: "and" | "or" = root.op === "or" ? "or" : "and";

  // Pass 1 — classify every root child exactly once.
  const flatRows = new Map<string, GridRow[]>();
  const cardGroups = new Map<string, GroupNode[]>();
  const complex: ComplexGroup[] = [];
  const keyOrder: string[] = [];
  const seenKey = (key: string): void => {
    if (!keyOrder.includes(key)) keyOrder.push(key);
  };

  for (const child of root.children) {
    if (child.type === "condition") {
      const key = conditionKey(child.condition);
      seenKey(key);
      const rows = flatRows.get(key) ?? [];
      rows.push({ nodeId: child.id, condition: child.condition });
      flatRows.set(key, rows);
      continue;
    }
    const key = qualifiesAsCard(child);
    if (key === null) {
      complex.push({ node: child });
      continue;
    }
    seenKey(key);
    const groups = cardGroups.get(key) ?? [];
    groups.push(child);
    cardGroups.set(key, groups);
  }

  // Pass 2 — build one card per key. Flat rows win over groups (write-back to
  // a card with BOTH would be ambiguous); surplus groups are demoted to
  // complex so nothing is ever silently flattened.
  const cards: WatchCard[] = [];
  for (const key of keyOrder) {
    const rows = flatRows.get(key) ?? [];
    const groups = cardGroups.get(key) ?? [];
    if (rows.length > 0) {
      for (const g of groups) complex.push({ node: g });
      cards.push({
        key,
        market: rows.map((r) => conditionMarket(r.condition)).find((m) => m !== null) ?? null,
        rows,
        op: rootOp,
        opNodeId: null,
        placeholder: false,
      });
      continue;
    }
    const [first, ...rest] = groups;
    if (!first) continue;
    for (const g of rest) complex.push({ node: g });
    const groupRows = first.children
      .filter((c): c is Extract<ExprNode, { type: "condition" }> => c.type === "condition")
      .map((c) => ({ nodeId: c.id, condition: c.condition }));
    cards.push({
      key,
      market: groupRows.map((r) => conditionMarket(r.condition)).find((m) => m !== null) ?? null,
      rows: groupRows,
      op: first.op === "or" ? "or" : "and",
      opNodeId: first.id,
      placeholder: false,
    });
  }

  // Pass 3 — editor-only watched markets nothing references yet.
  const targetTokenId =
    doc.action.kind === "order" && isBound(doc.action.market) ? doc.action.market.tokenId : null;
  for (const ref of doc.watchedMarkets) {
    if (!isBound(ref)) continue;
    if (ref.tokenId === targetTokenId) continue;
    if (cards.some((c) => c.key === ref.tokenId)) continue;
    cards.push({
      key: ref.tokenId,
      market: ref,
      rows: [],
      op: rootOp,
      opNodeId: null,
      placeholder: true,
    });
  }

  // Pass 4 — the target market's card becomes the ACT-zone guard list.
  let guards: GridRow[] = [];
  let guardsOp: "and" | "or" = rootOp;
  let guardsOpNodeId: string | null = null;
  if (targetTokenId !== null) {
    const idx = cards.findIndex((c) => c.key === targetTokenId);
    if (idx >= 0) {
      const card = cards[idx]!;
      guards = card.rows;
      guardsOp = card.op;
      guardsOpNodeId = card.opNodeId;
      cards.splice(idx, 1);
    }
  }

  return { rootOp, watch: cards, guards, guardsOp, guardsOpNodeId, complex };
};

/** True when the doc contains logic the grid cannot edit (canvas required). */
export const isComplexDoc = (doc: StrategyDoc): boolean => docToGrid(doc).complex.length > 0;

export interface ConditionLiveResult {
  satisfied: boolean;
  stale: boolean;
  actual: number | null;
}

/** Flatten an evaluation result tree into per-condition-node live readings. */
export const collectConditionResults = (
  root: ExprResultNode | null | undefined,
): Map<string, ConditionLiveResult> => {
  const out = new Map<string, ConditionLiveResult>();
  const walk = (node: ExprResultNode): void => {
    if (node.type === "condition") {
      out.set(node.id, {
        satisfied: node.satisfied,
        stale: node.result.stale,
        actual: node.result.actual,
      });
      return;
    }
    node.children.forEach(walk);
  };
  if (root) walk(root);
  return out;
};
