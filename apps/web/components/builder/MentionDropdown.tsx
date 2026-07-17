"use client";

/**
 * Presentational dropdown for @-mention market results. Keyboard is owned by
 * the host composer (Enter picks the active row, arrows move `activeIndex`,
 * Escape dismisses) — this component only renders rows and forwards clicks.
 */
import { cn } from "@/components/ui";
import type { MarketSearchResult } from "@/lib/smart-orders/queries";
import { cents, usdCompact, toNum } from "@/lib/format";

export function MentionDropdown({
  results,
  activeIndex = 0,
  onPick,
  className,
}: {
  results: MarketSearchResult[];
  activeIndex?: number;
  onPick: (r: MarketSearchResult) => void;
  className?: string;
}) {
  if (results.length === 0) return null;
  return (
    <div
      className={cn(
        "absolute bottom-full left-0 right-10 z-30 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop",
        className,
      )}
    >
      {results.map((r, i) => (
        <button
          key={r.conditionId}
          type="button"
          onClick={() => onPick(r)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2",
            i === activeIndex && "bg-surface-2",
          )}
        >
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
          ) : (
            <div className="h-6 w-6 shrink-0 rounded-md bg-surface-3" />
          )}
          <span className="min-w-0 flex-1">
            <span className="line-clamp-1 text-[12px] font-medium text-fg">{r.title}</span>
            <span className="tabular text-[10px] text-faint">
              {r.outcomes[0] ?? "Yes"} {cents(Number(r.outcomePrices[0] ?? 0))} ·{" "}
              {usdCompact(toNum(r.volume))} Vol
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
