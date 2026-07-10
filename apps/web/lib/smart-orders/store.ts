"use client";

/**
 * Builder draft store (zustand). All mutations are immutable tree operations
 * from doc.ts; the canvas, chip sentence and inspector subscribe to slices of
 * this one document.
 */
import { create } from "zustand";
import type { ActionV2, ConditionV2, MarketRef, RecurrenceV2, StrategyLimits } from "@mx2/rules";
import {
  emptyDoc,
  freshNodeId,
  findNode,
  isBound,
  removeNodeFromTree,
  replaceNodeInTree,
  toggleNotInTree,
  type MarketMeta,
  type NodePosition,
  type StrategyDoc,
} from "./doc";

export interface BuilderState {
  doc: StrategyDoc;
  /** Bumped on every semantic change — drives draft re-evaluation. */
  revision: number;
  /** Bumped when the AI panel replaces the doc — drives the staged node reveal. */
  revealTick: number;

  reset: (doc?: StrategyDoc) => void;
  revealAll: () => void;
  setName: (name: string) => void;
  setRootOp: (op: "and" | "or") => void;
  addCondition: (condition: ConditionV2) => string;
  updateCondition: (id: string, condition: ConditionV2) => void;
  removeNode: (id: string) => void;
  toggleNot: (id: string) => void;
  bindMarket: (nodeId: string | "action", ref: MarketRef, meta?: MarketMeta) => void;
  setAction: (action: ActionV2) => void;
  setLimits: (limits: StrategyLimits | null) => void;
  setRecurrence: (recurrence: RecurrenceV2) => void;
  setHoldsFor: (ms: number) => void;
  setMaxDataAge: (ms: number) => void;
  setExpiresAt: (ms: number | null) => void;
  select: (id: string | null) => void;
  setPosition: (id: string, pos: NodePosition) => void;
}

const bump = (doc: StrategyDoc, state: BuilderState): Pick<BuilderState, "doc" | "revision"> => ({
  doc,
  revision: state.revision + 1,
});

export const useBuilderStore = create<BuilderState>((set, get) => ({
  doc: emptyDoc(),
  revision: 0,
  revealTick: 0,

  reset: (doc) => set({ doc: doc ?? emptyDoc(), revision: get().revision + 1 }),

  // Editor-only (no revision bump — never retriggers evaluation).
  revealAll: () => set((s) => ({ revealTick: s.revealTick + 1 })),

  setName: (name) => set((s) => bump({ ...s.doc, name }, s)),

  setRootOp: (op) => set((s) => bump({ ...s.doc, expr: { ...s.doc.expr, op } }, s)),

  addCondition: (condition) => {
    const id = freshNodeId();
    set((s) =>
      bump(
        {
          ...s.doc,
          expr: {
            ...s.doc.expr,
            children: [...s.doc.expr.children, { type: "condition", id, condition }],
          },
          selectedNodeId: id,
        },
        s,
      ),
    );
    return id;
  },

  updateCondition: (id, condition) =>
    set((s) => {
      const node = findNode(s.doc.expr, id);
      if (!node || node.type !== "condition") return s;
      return bump({ ...s.doc, expr: replaceNodeInTree(s.doc.expr, id, { ...node, condition }) }, s);
    }),

  removeNode: (id) =>
    set((s) =>
      bump(
        {
          ...s.doc,
          expr: removeNodeFromTree(s.doc.expr, id),
          selectedNodeId: s.doc.selectedNodeId === id ? null : s.doc.selectedNodeId,
        },
        s,
      ),
    ),

  toggleNot: (id) => set((s) => bump({ ...s.doc, expr: toggleNotInTree(s.doc.expr, id) }, s)),

  bindMarket: (nodeId, ref, meta) =>
    set((s) => {
      const marketMeta = meta ? { ...s.doc.marketMeta, [ref.tokenId]: meta } : s.doc.marketMeta;
      if (nodeId === "action") {
        if (s.doc.action.kind !== "order") return s;
        return bump({ ...s.doc, marketMeta, action: { ...s.doc.action, market: ref } }, s);
      }
      const node = findNode(s.doc.expr, nodeId);
      if (!node || node.type !== "condition" || node.condition.kind === "time_window") return s;
      return bump(
        {
          ...s.doc,
          marketMeta,
          expr: replaceNodeInTree(s.doc.expr, nodeId, {
            ...node,
            condition: { ...node.condition, market: ref },
          }),
        },
        s,
      );
    }),

  setAction: (action) => set((s) => bump({ ...s.doc, action }, s)),

  setLimits: (limits) => set((s) => bump({ ...s.doc, limits }, s)),

  setRecurrence: (recurrence) => set((s) => bump({ ...s.doc, recurrence }, s)),

  setHoldsFor: (holdsForMs) => set((s) => bump({ ...s.doc, holdsForMs }, s)),

  setMaxDataAge: (maxDataAgeMs) => set((s) => bump({ ...s.doc, maxDataAgeMs }, s)),

  setExpiresAt: (expiresAtMs) => set((s) => bump({ ...s.doc, expiresAtMs }, s)),

  // Selection and node positions are editor-only: no revision bump, so they
  // never retrigger draft evaluation.
  select: (id) => set((s) => ({ doc: { ...s.doc, selectedNodeId: id } })),

  setPosition: (id, pos) =>
    set((s) => ({ doc: { ...s.doc, positions: { ...s.doc.positions, [id]: pos } } })),
}));

/** The first unbound market-condition node, if any (drives "pick a market" UX). */
export const firstUnboundNodeId = (doc: StrategyDoc): string | null => {
  const stack = [...doc.expr.children];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.type === "condition") {
      if (node.condition.kind !== "time_window" && !isBound(node.condition.market)) return node.id;
    } else {
      stack.push(...node.children);
    }
  }
  if (doc.action.kind === "order" && !isBound(doc.action.market)) return "action";
  return null;
};
