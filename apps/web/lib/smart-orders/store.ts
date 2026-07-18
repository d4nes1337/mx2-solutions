"use client";

/**
 * Builder draft store (zustand). All mutations are immutable tree operations
 * from doc.ts; the canvas, chip sentence and inspector subscribe to slices of
 * this one document.
 */
import { create } from "zustand";
import type { ActionV2, ConditionV2, MarketRef, RecurrenceV2, StrategyLimits } from "@mx2/rules";
import {
  docHasContent,
  emptyDoc,
  freshNodeId,
  findNode,
  isBound,
  isTokenReferenced,
  moveNodeInTree,
  removeNodeFromTree,
  replaceNodeInTree,
  toggleNotInTree,
  type MarketMeta,
  type NodePosition,
  type StrategyDoc,
} from "./doc";
import {
  DRAFT_SCHEMA_VERSION,
  deleteDraftLocal,
  loadDraftLocal,
  newDraftId,
  saveDraftLocal,
  type DraftChatMessage,
  type DraftHistoryEntry,
  type DraftRecord,
} from "./drafts";

/** Tabs of the right-hand workspace panel (editor-only UI state). */
export type WorkspaceTab = "ai" | "simulate" | "market" | "settings" | "block";

/** AI generation lifecycle — drives the canvas "drafting…" overlay. */
export type AiStatus = "idle" | "drafting" | "error";

/** Options for spawnDraft — see the action's doc comment. */
export interface SpawnDraftOptions {
  /** Fixed id (the edit flow's stable `edit-<ruleId>` slot). */
  id?: string;
  /** Origin tag persisted with the record ("template:dip", "ai", …). */
  origin?: string;
  /** Move the current AI conversation into the new draft (AI fork). */
  carryChat?: boolean;
}

export interface BuilderState {
  doc: StrategyDoc;
  /** Bumped on every semantic change — drives draft re-evaluation. */
  revision: number;
  /** Bumped when the AI panel replaces the doc — drives the staged node reveal. */
  revealTick: number;
  /** Active workspace-panel tab. Editor-only — never triggers evaluation. */
  activeTab: WorkspaceTab;
  /**
   * Where to return when the selection-driven Block tab closes (deselect).
   * Tracks the last tab the user chose that wasn't "block".
   */
  lastNonBlockTab: Exclude<WorkspaceTab, "block">;
  /** Token whose preview the Market tab shows (null = first referenced market). */
  focusedMarketToken: string | null;
  /** What the AI panel is doing right now (editor-only — canvas overlay). */
  aiStatus: AiStatus;
  /** Identity of the draft this canvas belongs to (null before first spawn). */
  draftId: string | null;
  /** Entry that created the draft — persisted with the record. */
  draftOrigin: string;
  /**
   * True until the user edits: a pristine spawn is replaced in place by the
   * next spawn (cycling presets doesn't spray drafts), an edited one forks.
   */
  pristine: boolean;
  /** User-edited since spawn/load — gates flush-on-switch and AI forking. */
  dirty: boolean;
  /** Per-draft AI chat: what the user sees (optimistic user turns included). */
  aiMessages: DraftChatMessage[];
  /** Per-draft compact API history (pushed on success only, capped). */
  aiHistory: DraftHistoryEntry[];

  reset: (doc?: StrategyDoc) => void;
  /**
   * Switch the canvas to a fresh draft. The outgoing draft is flushed to
   * localStorage first when it has unsaved user work, so no entry point can
   * overwrite in-progress state. Returns the new draft id.
   */
  spawnDraft: (doc?: StrategyDoc, opts?: SpawnDraftOptions) => string;
  /** Restore a persisted draft (doc + AI chat). False when missing/unreadable. */
  loadDraft: (id: string) => boolean;
  /**
   * Start from scratch: wipe the current canvas AND its AI chat, deleting the
   * persisted record. Keeps the draft id so ?draft= URLs stay stable.
   */
  clearCanvas: () => void;
  pushAiMessage: (msg: DraftChatMessage) => void;
  pushAiHistory: (turns: DraftHistoryEntry[]) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setAiStatus: (status: AiStatus) => void;
  focusMarket: (tokenId: string | null) => void;
  revealAll: () => void;
  setName: (name: string) => void;
  setRootOp: (op: "and" | "or") => void;
  /** Append a condition — to the root, or into the group `parentId`. */
  addCondition: (condition: ConditionV2, parentId?: string) => string;
  /** Append an empty AND/OR group to the root (fill via the group editor). */
  addGroup: (op: "and" | "or") => string;
  updateCondition: (id: string, condition: ConditionV2) => void;
  removeNode: (id: string) => void;
  toggleNot: (id: string) => void;
  /** Reparent a condition/group (canvas edge gestures). No-op when refused. */
  moveNode: (id: string, newParentId: string) => void;
  bindMarket: (nodeId: string | "action", ref: MarketRef, meta?: MarketMeta) => void;
  /** Add a market node to the canvas without binding anything to it yet. */
  addWatchedMarket: (ref: MarketRef, meta?: MarketMeta) => void;
  /** Remove a watched market — refused while a condition/action references it. */
  removeWatchedMarket: (tokenId: string) => void;
  setAction: (action: ActionV2) => void;
  setLimits: (limits: StrategyLimits | null) => void;
  setRecurrence: (recurrence: RecurrenceV2) => void;
  setHoldsFor: (ms: number) => void;
  setMaxDataAge: (ms: number) => void;
  setExpiresAt: (ms: number | null) => void;
  select: (id: string | null) => void;
  setPosition: (id: string, pos: NodePosition) => void;
}

const bump = (
  doc: StrategyDoc,
  state: BuilderState,
): Pick<BuilderState, "doc" | "revision" | "dirty" | "pristine"> => ({
  doc,
  revision: state.revision + 1,
  dirty: true,
  pristine: false,
});

/** Display-log cap — plenty for a session without unbounded growth. */
const MAX_AI_MESSAGES = 40;
/** API-history cap — the compact context re-sent with every generate call. */
const MAX_AI_HISTORY = 6;

/** The current canvas serialized as a persistable draft record. */
export const draftRecordFromState = (s: BuilderState): DraftRecord => ({
  id: s.draftId!,
  schemaVersion: DRAFT_SCHEMA_VERSION,
  name: s.doc.name,
  origin: s.draftOrigin,
  updatedAt: Date.now(),
  doc: s.doc,
  aiMessages: s.aiMessages,
  aiHistory: s.aiHistory,
});

/**
 * Persistence gate: only user-touched drafts (edits or an AI conversation)
 * are written, so untouched preset spawns never clutter the drafts list.
 */
export const draftNeedsSave = (s: BuilderState): boolean =>
  s.draftId !== null && docHasContent(s.doc) && (s.dirty || s.aiMessages.length > 0);

export const useBuilderStore = create<BuilderState>((set, get) => ({
  doc: emptyDoc(),
  revision: 0,
  revealTick: 0,
  activeTab: "ai",
  lastNonBlockTab: "ai",
  focusedMarketToken: null,
  aiStatus: "idle",
  draftId: null,
  draftOrigin: "blank",
  pristine: true,
  dirty: false,
  aiMessages: [],
  aiHistory: [],

  reset: (doc) =>
    set({ doc: doc ?? emptyDoc(), revision: get().revision + 1, dirty: true, pristine: false }),

  spawnDraft: (doc, opts) => {
    const s = get();
    const reuse = !opts?.id && s.pristine && s.draftId !== null;
    if (!reuse && draftNeedsSave(s)) saveDraftLocal(draftRecordFromState(s));
    const id = opts?.id ?? (reuse ? s.draftId! : newDraftId());
    set({
      draftId: id,
      draftOrigin: opts?.origin ?? "blank",
      doc: doc ?? emptyDoc(),
      revision: s.revision + 1,
      dirty: false,
      // A chat-carrying fork is already invested work — don't reuse it in place.
      pristine: !opts?.carryChat,
      aiMessages: opts?.carryChat ? s.aiMessages : [],
      aiHistory: opts?.carryChat ? s.aiHistory : [],
      focusedMarketToken: null,
      aiStatus: "idle",
    });
    return id;
  },

  loadDraft: (id) => {
    const s = get();
    if (s.draftId === id) return true;
    const rec = loadDraftLocal(id);
    if (!rec) return false;
    if (draftNeedsSave(s)) saveDraftLocal(draftRecordFromState(s));
    set({
      draftId: rec.id,
      draftOrigin: rec.origin,
      doc: rec.doc,
      aiMessages: rec.aiMessages,
      aiHistory: rec.aiHistory,
      revision: s.revision + 1,
      dirty: false,
      pristine: false,
      focusedMarketToken: null,
      aiStatus: "idle",
    });
    return true;
  },

  clearCanvas: () => {
    const s = get();
    if (s.draftId) deleteDraftLocal(s.draftId);
    set({
      doc: emptyDoc(),
      aiMessages: [],
      aiHistory: [],
      revision: s.revision + 1,
      dirty: false,
      pristine: true,
      focusedMarketToken: null,
      aiStatus: "idle",
    });
  },

  pushAiMessage: (msg) =>
    set((s) => ({ aiMessages: [...s.aiMessages, msg].slice(-MAX_AI_MESSAGES) })),

  pushAiHistory: (turns) =>
    set((s) => ({ aiHistory: [...s.aiHistory, ...turns].slice(-MAX_AI_HISTORY) })),

  // Editor-only (no revision bump — never retriggers evaluation).
  revealAll: () => set((s) => ({ revealTick: s.revealTick + 1 })),
  setActiveTab: (activeTab) =>
    set(activeTab === "block" ? { activeTab } : { activeTab, lastNonBlockTab: activeTab }),
  focusMarket: (focusedMarketToken) => set({ focusedMarketToken }),
  setAiStatus: (aiStatus) => set({ aiStatus }),

  setName: (name) => set((s) => bump({ ...s.doc, name }, s)),

  setRootOp: (op) => set((s) => bump({ ...s.doc, expr: { ...s.doc.expr, op } }, s)),

  addCondition: (condition, parentId) => {
    const id = freshNodeId();
    set((s) => {
      const child = { type: "condition" as const, id, condition };
      const parent = parentId ? findNode(s.doc.expr, parentId) : null;
      const expr =
        parent && parent.type === "group"
          ? (replaceNodeInTree(s.doc.expr, parent.id, {
              ...parent,
              children: [...parent.children, child],
            }) as typeof s.doc.expr)
          : { ...s.doc.expr, children: [...s.doc.expr.children, child] };
      return bump({ ...s.doc, expr, selectedNodeId: id }, s);
    });
    return id;
  },

  addGroup: (op) => {
    const id = freshNodeId();
    set((s) =>
      bump(
        {
          ...s.doc,
          expr: {
            ...s.doc.expr,
            children: [...s.doc.expr.children, { type: "group", id, op, children: [] }],
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

  moveNode: (id, newParentId) =>
    set((s) => {
      const expr = moveNodeInTree(s.doc.expr, id, newParentId);
      return expr === s.doc.expr ? s : bump({ ...s.doc, expr }, s);
    }),

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

  // Watched markets are editor-only (compile strips them): no revision bump —
  // the canvas rebuilds off doc identity, and evaluation doesn't depend on them.
  // They ARE user work though, so they mark the draft dirty for persistence.
  addWatchedMarket: (ref, meta) =>
    set((s) => {
      if (!isBound(ref) || s.doc.watchedMarkets.some((m) => m.tokenId === ref.tokenId)) return s;
      const marketMeta = meta ? { ...s.doc.marketMeta, [ref.tokenId]: meta } : s.doc.marketMeta;
      return {
        doc: { ...s.doc, marketMeta, watchedMarkets: [...s.doc.watchedMarkets, ref] },
        focusedMarketToken: ref.tokenId,
        dirty: true,
        pristine: false,
      };
    }),

  removeWatchedMarket: (tokenId) =>
    set((s) => {
      if (isTokenReferenced(s.doc, tokenId)) return s;
      return {
        doc: {
          ...s.doc,
          watchedMarkets: s.doc.watchedMarkets.filter((m) => m.tokenId !== tokenId),
          selectedNodeId:
            s.doc.selectedNodeId === `market:${tokenId}` ? null : s.doc.selectedNodeId,
        },
        focusedMarketToken: s.focusedMarketToken === tokenId ? null : s.focusedMarketToken,
        dirty: true,
        pristine: false,
      };
    }),

  setAction: (action) => set((s) => bump({ ...s.doc, action }, s)),

  setLimits: (limits) => set((s) => bump({ ...s.doc, limits }, s)),

  setRecurrence: (recurrence) => set((s) => bump({ ...s.doc, recurrence }, s)),

  setHoldsFor: (holdsForMs) => set((s) => bump({ ...s.doc, holdsForMs }, s)),

  setMaxDataAge: (maxDataAgeMs) => set((s) => bump({ ...s.doc, maxDataAgeMs }, s)),

  setExpiresAt: (expiresAtMs) => set((s) => bump({ ...s.doc, expiresAtMs }, s)),

  // Selection and node positions are editor-only: no revision bump, so they
  // never retrigger draft evaluation. Positions still count as user work
  // (layout investment) for draft persistence; selection does not.
  select: (id) => set((s) => ({ doc: { ...s.doc, selectedNodeId: id } })),

  setPosition: (id, pos) =>
    set((s) => ({
      doc: { ...s.doc, positions: { ...s.doc.positions, [id]: pos } },
      dirty: true,
      pristine: false,
    })),
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
