"use client";

/**
 * Dev-only demo feed for the Funds experience. When NEXT_PUBLIC_FUNDS_DEMO=1,
 * useActiveTransfers renders these fabricated transfers instead of real
 * queries, letting the whole flow — tracker stages, celebrations, the pill —
 * be watched end-to-end with zero real money. Never enabled in production
 * builds unless the env var is explicitly set.
 */
import { create } from "zustand";
import type { ActiveTransfer } from "./transfers";

export const FUNDS_DEMO_ENABLED = process.env.NEXT_PUBLIC_FUNDS_DEMO === "1";

interface FundsDemoState {
  /** Non-null overrides the real transfer feed (empty array = demo idle). */
  transfers: ActiveTransfer[] | null;
  setTransfers: (transfers: ActiveTransfer[]) => void;
  clear: () => void;
}

export const useFundsDemo = create<FundsDemoState>((set) => ({
  transfers: null,
  setTransfers: (transfers) => set({ transfers }),
  clear: () => set({ transfers: null }),
}));
