"use client";

import { create } from "zustand";

/**
 * Global waitlist pop-up state (owner decision 2026-07-23: the waitlist is a
 * modal, not a standalone page). Mirrors the funds-ui store pattern — one
 * WaitlistModal instance lives in AppChrome; any surface (invite gate,
 * /waitlist deep link, future homepage CTA) opens it through this store.
 */
interface WaitlistUiState {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
}

export const useWaitlistUi = create<WaitlistUiState>((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
}));
