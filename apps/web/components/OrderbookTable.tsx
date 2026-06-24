"use client";

import type { OrderLevel } from "@/lib/types";
import { pct, toNum } from "@/lib/format";

function Levels({ levels, side }: { levels: OrderLevel[]; side: "bid" | "ask" }) {
  // bids: highest price first; asks: lowest price first.
  const sorted = [...levels].sort((a, b) =>
    side === "bid" ? toNum(b.price) - toNum(a.price) : toNum(a.price) - toNum(b.price),
  );
  const top = sorted.slice(0, 8);
  const maxSize = Math.max(1, ...top.map((l) => toNum(l.size)));
  const color = side === "bid" ? "var(--pos)" : "var(--neg)";

  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[11px] uppercase tracking-wide text-muted">
        <span>{side === "bid" ? "Bids" : "Asks"}</span>
        <span>Size</span>
      </div>
      {top.length === 0 ? (
        <div className="py-2 text-xs text-muted">No {side}s</div>
      ) : (
        top.map((l, i) => (
          <div key={i} className="relative flex justify-between px-1 py-0.5 text-xs">
            <div
              className="absolute inset-y-0 right-0"
              style={{
                width: `${(toNum(l.size) / maxSize) * 100}%`,
                background: color,
                opacity: 0.1,
              }}
            />
            <span className="tabular z-[1]" style={{ color }}>
              {pct(l.price)}
            </span>
            <span className="tabular z-[1] text-muted">{toNum(l.size).toFixed(2)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function OrderbookTable({ bids, asks }: { bids: OrderLevel[]; asks: OrderLevel[] }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Levels levels={bids} side="bid" />
      <Levels levels={asks} side="ask" />
    </div>
  );
}
