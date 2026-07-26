"use client";

/**
 * Persistent corner stack of ready-to-sign strategies — replaces the old
 * auto-hiding toast. A ready item is a fill window, not a notification: it
 * stays until the user reviews it or explicitly says "Not now" (the item then
 * still lives in the bell). Renders regardless of the browser-alerts opt-in —
 * this is in-app UI, not an OS notification.
 */
import { X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { ActionCenterItem } from "@/lib/types";

const cents = (v: string) => `${Math.round(Number(v) * 100)}¢`;

const MAX_VISIBLE = 3;

export function ReadyCorner({
  items,
  onReview,
  onLater,
  onOpenDrawer,
}: {
  items: ActionCenterItem[];
  onReview: (triggerId: string) => void;
  /** Per-tab snooze: hides the card; the item stays in the bell. */
  onLater: (triggerId: string) => void;
  onOpenDrawer: () => void;
}) {
  if (items.length === 0) return null;
  const visible = items.slice(0, MAX_VISIBLE);
  const overflow = items.length - visible.length;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {visible.map((item) => (
        <div
          key={item.triggerId}
          className="rounded-lg border border-brand/40 bg-surface p-3 shadow-pop"
        >
          <div className="flex items-start justify-between gap-2">
            <Badge tone="brand" dot>
              Conditions met
            </Badge>
            <button
              type="button"
              aria-label="Not now"
              onClick={() => onLater(item.triggerId)}
              className="text-faint transition-colors hover:text-fg"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <p className="mt-1.5 truncate text-[13px] font-semibold text-fg">{item.ruleName}</p>
          <p className="text-[12px] text-muted">
            {item.action.side === "BUY" ? "Buy" : "Sell"} {item.action.sizeShares}{" "}
            {item.market.outcome} at up to {cents(item.action.price)} · max $
            {item.action.maxSpendUsd}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => onReview(item.triggerId)}>
              Review & sign
            </Button>
            <button
              type="button"
              onClick={() => onLater(item.triggerId)}
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              Not now
            </button>
          </div>
        </div>
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={onOpenDrawer}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-left text-[12px] text-muted shadow-panel transition-colors hover:text-fg"
        >
          +{overflow} more ready in the bell
        </button>
      ) : null}
    </div>
  );
}
