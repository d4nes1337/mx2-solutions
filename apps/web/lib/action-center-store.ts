"use client";

import { create } from "zustand";

/**
 * Global Action Center UI state (zustand, funds-ui pattern). The single
 * ActionCenterHost in AppChrome owns the drawer + the review modal; the header
 * bell, toast, and item CTAs all drive them through this store so there is
 * exactly one drawer and one signing modal app-wide.
 */
interface ActionCenterUi {
  /** Drawer / bottom-sheet open. */
  open: boolean;
  /** Trigger currently opened in the fresh-review TriggerConfirm modal. */
  reviewTriggerId: string | null;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  /** Open the fresh review + signing modal for a trigger (closes the drawer). */
  openReview: (triggerId: string) => void;
  closeReview: () => void;
}

export const useActionCenterUi = create<ActionCenterUi>((set) => ({
  open: false,
  reviewTriggerId: null,
  openDrawer: () => set({ open: true }),
  closeDrawer: () => set({ open: false }),
  toggleDrawer: () => set((s) => ({ open: !s.open })),
  openReview: (triggerId) => set({ reviewTriggerId: triggerId, open: false }),
  closeReview: () => set({ reviewTriggerId: null }),
}));
