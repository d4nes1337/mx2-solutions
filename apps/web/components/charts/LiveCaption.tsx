"use client";

import { useNow } from "@/lib/strategies/use-now";
import { liveMid, type LiveQuote } from "@/lib/strategies/live-splice";
import { cn } from "@/components/ui";

const centsFmt = (v: number) => `${Math.round(v * 100)}¢`;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};

/**
 * One honest line under a chart: the live price, the book, and exactly how
 * old that information is. `receivedAtMs` is the query's dataUpdatedAt so the
 * age keeps ticking between polls; renders nothing until a quote exists.
 */
export function LiveCaption({
  quote,
  receivedAtMs,
  className,
}: {
  quote: LiveQuote | null | undefined;
  /** When the quote landed client-side (query.dataUpdatedAt); defaults to now. */
  receivedAtMs?: number;
  className?: string;
}) {
  const now = useNow();
  const mid = liveMid(quote);
  if (!quote || mid == null) return null;

  const ageMs = (quote.dataAgeMs ?? 0) + Math.max(0, now - (receivedAtMs ?? now));
  const stale = ageMs > 60_000;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular",
        stale ? "text-warn" : "text-muted",
        className,
      )}
    >
      <span>
        live <span className="font-semibold text-fg">{centsFmt(mid)}</span>
      </span>
      {quote.bestBid != null || quote.bestAsk != null ? (
        <span>
          bid {quote.bestBid != null ? centsFmt(quote.bestBid) : "—"} / ask{" "}
          {quote.bestAsk != null ? centsFmt(quote.bestAsk) : "—"}
        </span>
      ) : null}
      <span>· updated {ago(ageMs)}</span>
    </div>
  );
}
