"use client";

/**
 * Global Funds UI state (zustand): the single FundsSheet instance (hosted in
 * FundsHost) is driven from here so the header button, wallet cards, deep
 * links, and the pending-transfer pill all open the same sheet. `seenStates`
 * is the session's memory of transfer states — a pending→success transition
 * observed here (and only here) triggers the celebration/pill check, so
 * historical completed rows never celebrate on mount.
 */
import { create } from "zustand";

export type FundsTab = "topup" | "withdraw" | "history";

interface SeenState {
  state: string;
  /** Set when the pending→success transition was observed this session. */
  completedAt?: number;
}

export interface FundsUiState {
  open: boolean;
  tab: FundsTab;
  /** History row to auto-expand when the sheet opens (pill click-through). */
  focusTransferId: string | null;
  /** Pill stays hidden for transfers created before this dismissal. */
  pillDismissedAt: number | null;
  seenStates: Record<string, SeenState>;
  openSheet: (tab?: FundsTab, focusTransferId?: string) => void;
  closeSheet: () => void;
  setTab: (tab: FundsTab) => void;
  dismissPill: () => void;
  recordState: (id: string, state: string, isSuccess: boolean) => void;
}

export const useFundsUi = create<FundsUiState>((set) => ({
  open: false,
  tab: "topup",
  focusTransferId: null,
  pillDismissedAt: null,
  seenStates: {},

  openSheet: (tab = "topup", focusTransferId) =>
    set({ open: true, tab, focusTransferId: focusTransferId ?? null }),

  closeSheet: () => set({ open: false, focusTransferId: null }),

  setTab: (tab) => set({ tab, focusTransferId: null }),

  dismissPill: () => set({ pillDismissedAt: Date.now() }),

  recordState: (id, state, isSuccess) =>
    set((s) => {
      const prev = s.seenStates[id];
      // Unchanged state → no store churn (recordState runs on every poll).
      if (prev?.state === state) return s;
      const next: SeenState = { state };
      if (prev?.completedAt) next.completedAt = prev.completedAt;
      // Celebrate only observed transitions: a row FIRST seen as success was
      // completed before this session and stays quiet.
      if (isSuccess && prev && !prev.completedAt) next.completedAt = Date.now();
      return { seenStates: { ...s.seenStates, [id]: next } };
    }),
}));
