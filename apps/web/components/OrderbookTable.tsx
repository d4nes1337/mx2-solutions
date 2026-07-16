"use client";

import type { OrderLevel } from "@/lib/types";
import { cents, toNum } from "@/lib/format";
import { FlashOnChange } from "./motion";
import { cn } from "./ui";

export interface BookSelection {
  price: number;
  size: number;
  side: "bid" | "ask";
}

interface BookRow {
  price: number;
  size: number;
  cum: number;
}

function computeRows(levels: OrderLevel[], side: "bid" | "ask"): BookRow[] {
  const sorted = [...levels].sort((a, b) =>
    side === "bid" ? toNum(b.price) - toNum(a.price) : toNum(a.price) - toNum(b.price),
  );
  let cum = 0;
  return sorted.slice(0, 8).map((l) => {
    const size = toNum(l.size);
    cum += size;
    return { price: toNum(l.price), size, cum };
  });
}

function fmtSize(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return n.toFixed(0);
  return n.toFixed(2);
}

/**
 * Depth-bar order book (Hyperliquid-style): cumulative depth bars grow toward the
 * spread, levels are clickable to prefill the ticket, and the mid flashes on
 * change. Bars share a scale across both sides so imbalance is visible.
 */
export function OrderbookTable({
  bids,
  asks,
  onSelect,
}: {
  bids: OrderLevel[];
  asks: OrderLevel[];
  onSelect?: (sel: BookSelection) => void;
}) {
  const bidRows = computeRows(bids, "bid");
  const askRows = computeRows(asks, "ask");
  const maxCum = Math.max(
    1,
    bidRows[bidRows.length - 1]?.cum ?? 0,
    askRows[askRows.length - 1]?.cum ?? 0,
  );

  const bestBid = bidRows[0]?.price ?? 0;
  const bestAsk = askRows[0]?.price ?? 0;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;

  return (
    <div>
      <div className="mb-1.5 grid grid-cols-2 text-[10px] uppercase tracking-wide text-muted">
        <span>Bid · size</span>
        <span className="text-right">size · Ask</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <BookSide rows={bidRows} side="bid" maxCum={maxCum} onSelect={onSelect} />
        <BookSide rows={askRows} side="ask" maxCum={maxCum} onSelect={onSelect} />
      </div>
      <div className="mt-3 flex items-center justify-center gap-2.5 rounded-md border border-border bg-surface-2/40 py-1.5 text-[11px]">
        <span className="text-muted">Mid</span>
        <FlashOnChange value={mid}>
          <span className="tabular font-semibold text-fg">{mid ? cents(mid) : "—"}</span>
        </FlashOnChange>
        <span className="text-faint">·</span>
        <span className="text-muted">Spread</span>
        <span className="tabular font-semibold text-warn">{spread > 0 ? cents(spread) : "—"}</span>
      </div>
    </div>
  );
}

function BookSide({
  rows,
  side,
  maxCum,
  onSelect,
}: {
  rows: BookRow[];
  side: "bid" | "ask";
  maxCum: number;
  onSelect?: (sel: BookSelection) => void;
}) {
  const color = side === "bid" ? "var(--pos)" : "var(--neg)";
  if (!rows.length) {
    return <div className="py-2 text-xs text-muted">No {side}s</div>;
  }
  // Without onSelect the book is a read-only display — plain rows, not a
  // column of disabled buttons.
  const RowEl = onSelect ? "button" : "div";
  return (
    <div className="space-y-0.5">
      {rows.map((r, i) => (
        <RowEl
          key={i}
          {...(onSelect
            ? {
                type: "button" as const,
                onClick: () => onSelect({ price: r.price, size: r.size, side }),
                title: `Trade at ${cents(r.price)}`,
              }
            : {})}
          className={cn(
            "relative flex w-full items-center justify-between rounded-sm px-1.5 py-1 text-xs transition-colors",
            onSelect ? "cursor-pointer hover:bg-surface-3/70" : "cursor-default",
          )}
        >
          <span
            className={cn(
              "absolute inset-y-0 rounded-sm transition-[width] duration-500 ease-snap",
              side === "bid" ? "right-0" : "left-0",
            )}
            style={{ width: `${(r.cum / maxCum) * 100}%`, background: color, opacity: 0.12 }}
          />
          {side === "bid" ? (
            <>
              <span className="tabular z-[1] font-medium" style={{ color }}>
                {cents(r.price)}
              </span>
              <span className="tabular z-[1] text-muted">{fmtSize(r.size)}</span>
            </>
          ) : (
            <>
              <span className="tabular z-[1] text-muted">{fmtSize(r.size)}</span>
              <span className="tabular z-[1] font-medium" style={{ color }}>
                {cents(r.price)}
              </span>
            </>
          )}
        </RowEl>
      ))}
    </div>
  );
}
