"use client";

import { useEffect, useRef, useState } from "react";
import type { EnrichedOpenOrder, OrderLevel } from "@/lib/types";
import { cents, toNum, usdCompact } from "@/lib/format";
import { useOpenOrders } from "@/lib/queries";
import { Card, CardHeader, Empty, LiveDot, cn } from "../ui";

// ── Pure estimate math (unit-tested) ─────────────────────────────────────────
//
// Polymarket's public book is aggregated per price level, not a per-order FIFO
// queue — so an EXACT rank is not derivable. Estimate: a resting BUY sits on the
// bid, a SELL on the ask; `aheadNow` is the resting size at your price minus your
// own remaining. By time priority, size added later sits BEHIND you, so tracking
// the running MINIMUM of `aheadNow` over time is our best guess of what's truly
// ahead. Once `size_matched` rises, we switch to real fill progress.

export interface QueueSnapshot {
  price: number;
  original: number;
  matched: number;
  remaining: number;
  filling: boolean;
  levelSize: number;
  aheadNow: number;
}

export function queueSnapshot(
  order: Pick<EnrichedOpenOrder, "price" | "original_size" | "size_matched" | "side">,
  bids: OrderLevel[],
  asks: OrderLevel[],
): QueueSnapshot {
  const price = toNum(order.price);
  const original = toNum(order.original_size);
  const matched = toNum(order.size_matched ?? "0");
  const remaining = Math.max(0, original - matched);
  const levels = order.side === "BUY" ? bids : asks;
  const levelSize = levels
    .filter((l) => Math.abs(toNum(l.price) - price) < 1e-9)
    .reduce((s, l) => s + toNum(l.size), 0);
  return {
    price,
    original,
    matched,
    remaining,
    filling: matched > 0,
    levelSize,
    aheadNow: Math.max(0, levelSize - remaining),
  };
}

export function queueProgress(aheadMin: number, start: number, filling: boolean): number {
  if (filling) return 1;
  if (start <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - aheadMin / start));
}

function fmtShares(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 1 ? n.toFixed(0) : n.toFixed(2);
}

// ── Single-order "place in line" bar ─────────────────────────────────────────

export function QueuePosition({
  order,
  bids,
  asks,
}: {
  order: EnrichedOpenOrder;
  bids: OrderLevel[];
  asks: OrderLevel[];
}) {
  const snap = queueSnapshot(order, bids, asks);
  const startRef = useRef<number | null>(null);
  const [aheadMin, setAheadMin] = useState(snap.aheadNow);

  useEffect(() => {
    if (startRef.current == null && (snap.levelSize > 0 || snap.filling)) {
      startRef.current = snap.aheadNow;
    }
    setAheadMin((m) => Math.min(m, snap.aheadNow));
  }, [snap.aheadNow, snap.levelSize, snap.filling]);

  const known = startRef.current != null || snap.filling;
  const start = startRef.current ?? Math.max(snap.aheadNow, 1);
  const progress = queueProgress(aheadMin, start, snap.filling);
  const fillFrac = snap.original > 0 ? snap.matched / snap.original : 0;
  const tone = order.side === "BUY" ? "pos" : "neg";

  return (
    <div className="rounded-md border border-border bg-surface-2/50 p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "rounded-sm px-1 py-px text-[10px] font-semibold",
              tone === "pos" ? "bg-pos/10 text-pos" : "bg-neg/10 text-neg",
            )}
          >
            {order.side}
          </span>
          <span className="tabular text-muted">
            {fmtShares(snap.remaining)} @ {cents(snap.price)}
          </span>
        </span>
        {snap.filling ? (
          <LiveDot label="FILLING" tone="pos" />
        ) : (
          <span className="text-[10px] text-faint">≈ est.</span>
        )}
      </div>

      {known ? (
        <>
          <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-snap",
                snap.filling && "celebrate",
              )}
              style={{
                width: `${progress * 100}%`,
                background: snap.filling ? "var(--pos)" : "var(--brand-strong)",
              }}
            />
            <div
              className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-fg"
              style={{ left: `calc(${progress * 100}% - 1px)` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px]">
            {snap.filling ? (
              <span className="tabular text-pos">{Math.round(fillFrac * 100)}% filled</span>
            ) : (
              <span className="tabular text-muted">
                ≈ {usdCompact(aheadMin * snap.price)} ({fmtShares(aheadMin)} sh) ahead
              </span>
            )}
            <span className="tabular text-faint">{Math.round(progress * 100)}% to front</span>
          </div>
        </>
      ) : (
        <p className="mt-2 text-[10px] text-muted">
          Resting outside the visible top-of-book — queue position unavailable at this depth.
        </p>
      )}
    </div>
  );
}

// ── Card: your resting orders on the selected outcome ────────────────────────

export function QueueCard({
  signedIn,
  tokenId,
  bids,
  asks,
}: {
  signedIn: boolean;
  tokenId?: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
}) {
  const orders = useOpenOrders(signedIn);
  const mine = (orders.data?.openOrders ?? []).filter(
    (o) =>
      tokenId &&
      o.asset_id === tokenId &&
      toNum(o.original_size) - toNum(o.size_matched ?? "0") > 0,
  );

  if (!signedIn || mine.length === 0) return null;

  return (
    <Card>
      <CardHeader right={<LiveDot label="QUEUE" />}>Your place in line</CardHeader>
      <div className="space-y-2 p-4">
        {mine.map((o) => (
          <QueuePosition key={o.id} order={o} bids={bids} asks={asks} />
        ))}
        <p className="text-[10px] leading-relaxed text-faint">
          Live estimate from public book depth — becomes exact once your order starts filling.{" "}
          <span className="text-muted">Not a guaranteed queue rank.</span>
        </p>
      </div>
    </Card>
  );
}
