"use client";

// Tiny registry so the header's Help button can (re)start whichever page tour
// is currently mounted, without any coupling between Header and the pages.

import { useSyncExternalStore } from "react";

type TourStarter = () => void;

let starter: TourStarter | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};

export function registerTourStarter(fn: TourStarter): () => void {
  starter = fn;
  notify();
  return () => {
    if (starter === fn) {
      starter = null;
      notify();
    }
  };
}

export function startRegisteredTour(): void {
  starter?.();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Whether the current page has a tour the Help button can launch. */
export function useTourAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => starter !== null,
    () => false,
  );
}
