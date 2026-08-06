"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "./auth";

/**
 * Signing-prompt fast path: subscribes to the per-wallet SSE stream
 * (`/api/realtime/stream`, fed by the worker's commit-time Postgres NOTIFY)
 * and invalidates the action-center/strategy queries the moment a trigger is
 * created or resolved. Cuts "conditions met → Review & sign visible" from a
 * worst-case ~9 s of polling to roughly the network round-trip.
 *
 * Deliberately an accelerator only: every poll this app already runs stays
 * untouched, so a dropped stream degrades to exactly the pre-SSE behavior.
 * EventSource reconnects on its own (server sends `retry: 3000`).
 */
export function useRealtimeInvalidation(): void {
  const qc = useQueryClient();
  const session = useSession();
  const signedIn = Boolean(session.data);

  useEffect(() => {
    if (!signedIn || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/realtime/stream");

    const onEvent = (raw: MessageEvent): void => {
      let event: { kind?: string; triggerId?: string } = {};
      try {
        event = JSON.parse(raw.data as string) as { kind?: string; triggerId?: string };
      } catch {
        return;
      }
      // Everything the action center and strategy surfaces read.
      void qc.invalidateQueries({ queryKey: ["action-center"] });
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      if (event.triggerId) {
        void qc.invalidateQueries({ queryKey: ["trigger", event.triggerId] });
      }
    };

    source.addEventListener("mx2", onEvent);
    return () => {
      source.removeEventListener("mx2", onEvent);
      source.close();
    };
  }, [qc, signedIn]);
}
