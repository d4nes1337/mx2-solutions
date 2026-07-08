"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GammaEvent } from "@/lib/types";
import { primaryMarket, yesProbability } from "@/lib/feeds";
import { cents } from "@/lib/format";
import { cn } from "../ui";

interface TapeEntry {
  id: string;
  title: string;
  prob: number;
  dir: number; // -1 down, 0 flat, +1 up (since last poll)
}

/**
 * Derives a live "moves" ticker from the feed itself: each poll, markets whose
 * YES probability changed float to the front with a direction. Honest — these
 * are real polled moves, not fabricated trades. A true per-trade tape would need
 * a backend feed (documented seam in the plan).
 */
function useActivityTape(events: GammaEvent[] | undefined, max = 28): TapeEntry[] {
  const prev = useRef<Map<string, number>>(new Map());
  const [items, setItems] = useState<TapeEntry[]>([]);

  useEffect(() => {
    if (!events?.length) return;
    const next: TapeEntry[] = [];
    for (const e of events) {
      const m = primaryMarket(e);
      if (!m) continue;
      const prob = yesProbability(m);
      const before = prev.current.get(m.id);
      prev.current.set(m.id, prob);
      const dir = before == null ? 0 : Math.sign(prob - before);
      next.push({ id: m.id, title: e.markets.length > 1 ? m.question : e.title, prob, dir });
    }
    const changed = next.filter((n) => n.dir !== 0);
    const ordered = changed.length ? [...changed, ...next.filter((n) => n.dir === 0)] : next;
    setItems(ordered.slice(0, max));
  }, [events, max]);

  return items;
}

export function ActivityTape({ events }: { events?: GammaEvent[] }) {
  const items = useActivityTape(events);
  if (items.length < 3) return null;
  const loop = [...items, ...items]; // duplicated for the seamless -50% marquee

  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-surface-2/40">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-bg to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-bg to-transparent" />
      <div className="ticker-track py-1.5">
        {loop.map((it, i) => (
          <Link
            key={i}
            href={`/markets/${it.id}`}
            className="mx-3 inline-flex items-center gap-1.5 align-middle text-[11px] hover:text-fg"
          >
            <span
              className={cn(
                "h-1 w-1 shrink-0 rounded-full",
                it.dir > 0 ? "bg-pos" : it.dir < 0 ? "bg-neg" : "bg-faint",
              )}
            />
            <span className="max-w-[220px] truncate text-muted">{it.title}</span>
            <span
              className={cn(
                "tabular font-semibold",
                it.dir > 0 ? "text-pos" : it.dir < 0 ? "text-neg" : "text-fg",
              )}
            >
              {cents(it.prob)}
            </span>
            {it.dir !== 0 ? (
              <span className={it.dir > 0 ? "text-pos" : "text-neg"}>{it.dir > 0 ? "▲" : "▼"}</span>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
}
