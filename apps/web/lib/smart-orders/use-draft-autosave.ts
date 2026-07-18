"use client";

/**
 * Debounced local autosave for the builder: any change to the current draft's
 * doc or AI chat persists ~500ms later, with a synchronous flush on unmount.
 * Installed once by BuilderShell. Persistence is gated by draftNeedsSave, so
 * untouched preset spawns never clutter the drafts list.
 */
import { useEffect } from "react";
import { saveDraftLocal } from "./drafts";
import { pushDraftToServer } from "./drafts-sync";
import { draftNeedsSave, draftRecordFromState, useBuilderStore } from "./store";

const AUTOSAVE_DEBOUNCE_MS = 500;
/** Server push is slower-paced: one upsert per idle 2s, fail-soft. */
const SYNC_DEBOUNCE_MS = 2_000;

export function useDraftAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      const s = useBuilderStore.getState();
      if (draftNeedsSave(s)) saveDraftLocal(draftRecordFromState(s));
    };
    const push = () => {
      const s = useBuilderStore.getState();
      if (draftNeedsSave(s)) void pushDraftToServer(draftRecordFromState(s));
    };
    const unsub = useBuilderStore.subscribe((s, prev) => {
      if (
        s.doc === prev.doc &&
        s.aiMessages === prev.aiMessages &&
        s.aiHistory === prev.aiHistory
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, AUTOSAVE_DEBOUNCE_MS);
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(push, SYNC_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      if (syncTimer) clearTimeout(syncTimer);
      persist(); // Flush pending work when the builder unmounts.
      push();
    };
  }, []);
}
