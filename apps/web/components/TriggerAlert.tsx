"use client";

import { useState } from "react";
import { useTriggers } from "@/lib/queries";
import { Button } from "./ui";
import { TriggerConfirm } from "./TriggerConfirm";

/**
 * Prominent alert for rules that have triggered and await manual confirmation.
 * Renders nothing when there are none. Opening one shows the fresh-preview modal.
 */
export function TriggerAlert() {
  const triggers = useTriggers();
  const [openId, setOpenId] = useState<string | null>(null);

  const awaiting = triggers.data?.triggers ?? [];
  if (awaiting.length === 0) return null;

  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-warn">
          {awaiting.length} conditional {awaiting.length === 1 ? "rule has" : "rules have"}{" "}
          triggered — awaiting your confirmation
        </div>
      </div>
      <div className="mt-2 space-y-1">
        {awaiting.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2 text-xs"
          >
            <span className="text-muted">
              {t.evidence.preparedAction.side} {t.evidence.preparedAction.size} @{" "}
              {t.evidence.preparedAction.price} · {new Date(t.triggeredAt).toLocaleString()}
            </span>
            <Button onClick={() => setOpenId(t.id)}>Review &amp; confirm</Button>
          </div>
        ))}
      </div>
      {openId ? <TriggerConfirm triggerId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
