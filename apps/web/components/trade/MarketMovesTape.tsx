"use client";

import { useEffect, useRef, useState } from "react";
import type { OrderLevel } from "@/lib/types";
import { cents, toNum } from "@/lib/format";
import { LiveDot, cn } from "../ui";

/**
 * Compact "recent moves" tape for a single market — derived honestly from the
 * order-book mid across the 2s poll (labeled price moves, not fabricated trades;
 * a real per-trade feed would need a backend endpoint). New prints slide in.
 */
export function MarketMovesTape({ bids, asks }: { bids: OrderLevel[]; asks: OrderLevel[] }) {
  const bestBid = bids.length ? Math.max(...bids.map((l) => toNum(l.price))) : 0;
  const bestAsk = asks.length ? Math.min(...asks.map((l) => toNum(l.price))) : 0;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  const prev = useRef<number>(mid);
  const keyRef = useRef(0);
  const [prints, setPrints] = useState<{ v: number; dir: number; k: number }[]>([]);

  useEffect(() => {
    if (!mid) return;
    if (prints.length > 0 && Math.abs(mid - prev.current) < 1e-9) return;
    const dir = mid > prev.current ? 1 : mid < prev.current ? -1 : 0;
    prev.current = mid;
    setPrints((p) => [{ v: mid, dir, k: keyRef.current++ }, ...p].slice(0, 14));
  }, [mid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (prints.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-hidden rounded-md border border-border bg-surface-2/30 px-3 py-1.5">
      <LiveDot label="TAPE" />
      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-hidden">
        {prints.map((p) => (
          <span
            key={p.k}
            className={cn(
              "slide-in tabular shrink-0 rounded-sm px-1 text-[10px] font-medium",
              p.dir > 0 ? "bg-pos/10 text-pos" : p.dir < 0 ? "bg-neg/10 text-neg" : "text-muted",
            )}
          >
            {cents(p.v)}
            {p.dir > 0 ? "▲" : p.dir < 0 ? "▼" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
