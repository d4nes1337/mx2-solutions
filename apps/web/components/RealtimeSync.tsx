"use client";

import { useRealtimeInvalidation } from "@/lib/realtime";

/** Invisible mount point for the realtime SSE → query-invalidation bridge. */
export function RealtimeSync() {
  useRealtimeInvalidation();
  return null;
}
