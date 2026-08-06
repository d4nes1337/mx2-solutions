"use client";

/**
 * Exit intent for the builder's "save this draft?" prompt.
 *
 * Drafts are no longer autosaved (owner decision, 2026-07-31): the canvas is
 * in-memory until the user says to keep it. Anything that would throw that
 * canvas away — navigating out of the editor, opening another draft, starting
 * a blank one — parks its continuation here instead of running immediately.
 * UnsavedDraftPrompt resolves it once the user picks Save or Discard.
 */
import { create } from "zustand";

export interface LeaveIntent {
  /** What happens after Save/Discard resolves the prompt. */
  run: () => void;
  /** Sentence completing "…before you " in the prompt body. */
  because: string;
}

interface LeaveGuardState {
  pending: LeaveIntent | null;
  /** Park an intent — the prompt takes over from here. */
  request: (intent: LeaveIntent) => void;
  clear: () => void;
}

export const useLeaveGuard = create<LeaveGuardState>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}));
