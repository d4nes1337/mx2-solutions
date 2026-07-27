"use client";

/**
 * @market search: type-ahead over the event-grouped search with preview rows
 * (title, YES/NO prices, volume). Multi-market events expand in place so
 * sub-markets — totals/spreads in a match, candidates in an election — are one
 * tap away. Selecting an outcome binds a MarketRef. Crypto-asset queries pin
 * the instant-markets series card above the results; `idleContent` (e.g. the
 * instant-markets rail) renders while the query is empty.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import type { MarketRef } from "@mx2/rules";
import { Spinner, cn } from "@/components/ui";
import {
  useGroupedMarketSearch,
  type EventSearchResult,
  type MarketSearchResult,
} from "@/lib/strategies/queries";
import type { MarketMeta } from "@/lib/strategies/doc";
import { metaFromResult, refFromResult } from "@/lib/strategies/pick";
import { SeriesPinnedCard } from "./SeriesPinnedCard";

export function MarketSearch({
  onPick,
  onPickResult,
  autoFocus,
  placeholder = "Search markets — e.g. @election…",
  idleContent,
}: {
  /** Per-outcome pick: binds one MarketRef (YES or NO button). */
  onPick?: (ref: MarketRef, meta: MarketMeta) => void;
  /**
   * Whole-market pick: one "Use market" button returning the raw result
   * (both token ids) — for consumers that need the YES+NO pair (quote_loop).
   */
  onPickResult?: (result: MarketSearchResult) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Rendered below the input while the query is empty (instant rail etc.). */
  idleContent?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const search = useGroupedMarketSearch(q);

  const pick = (r: MarketSearchResult, outcomeIdx: number) => {
    const ref = refFromResult(r, outcomeIdx);
    if (!ref) return;
    onPick?.(ref, metaFromResult(r, outcomeIdx));
    setQ("");
  };

  const pickWhole = (r: MarketSearchResult) => {
    onPickResult?.(r);
    setQ("");
  };

  const marketRow = (r: MarketSearchResult, label?: string) => (
    <div
      key={r.marketId}
      className="rounded-lg border border-border bg-surface p-2 transition-colors hover:border-border-strong"
    >
      <div className="flex items-center gap-2">
        {r.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.image} alt="" className="h-7 w-7 shrink-0 rounded-md object-cover" />
        ) : (
          <div className="h-7 w-7 shrink-0 rounded-md bg-surface-3" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-fg">{label ?? r.title}</div>
          <div className="tabular flex items-center gap-1.5 text-[10px] text-faint">
            <span>
              Vol ${Number(r.volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            {r.recurrence ? (
              <span className="inline-flex items-center gap-0.5 text-accent">
                <RefreshCw size={9} aria-hidden />
                {r.recurrence}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {onPickResult ? (
          <button
            type="button"
            onClick={() => pickWhole(r)}
            className="flex-1 rounded-md border border-brand/40 bg-brand-soft px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-brand-soft/70"
          >
            Use market (YES + NO)
          </button>
        ) : (
          r.outcomes.slice(0, 2).map((o, i) => (
            <button
              key={o}
              type="button"
              onClick={() => pick(r, i)}
              className={cn(
                "flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                i === 0
                  ? "border-pos/30 bg-pos/10 text-pos hover:bg-pos/20"
                  : "border-neg/30 bg-neg/10 text-neg hover:bg-neg/20",
              )}
            >
              {o} {r.outcomePrices[i] ? `· ${Math.round(Number(r.outcomePrices[i]) * 100)}¢` : ""}
            </button>
          ))
        )}
      </div>
    </div>
  );

  const eventGroup = (event: EventSearchResult) => {
    if (event.markets.length <= 1) {
      const only = event.markets[0];
      return only ? marketRow(only) : null;
    }
    // Multi-market event: header + head market, expandable to every sibling.
    const expanded = expandedEvents[event.eventId] ?? false;
    const visible = expanded ? event.markets : event.markets.slice(0, 1);
    return (
      <div key={event.eventId} className="space-y-1">
        <button
          type="button"
          onClick={() =>
            setExpandedEvents((s) => ({ ...s, [event.eventId]: !(s[event.eventId] ?? false) }))
          }
          className="flex w-full items-center gap-1.5 px-1 text-left"
        >
          <ChevronDown
            size={11}
            aria-hidden
            className={cn("shrink-0 text-faint transition-transform", expanded && "rotate-180")}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted">
            {event.title}
          </span>
          <span className="shrink-0 text-[10px] text-faint">
            {event.markets.length} markets{event.negRisk ? " · winner-take-all" : ""}
          </span>
        </button>
        {visible.map((m) =>
          marketRow(m, m.groupItemTitle.trim() !== "" ? m.groupItemTitle : m.title),
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 focus-within:border-brand">
        <Search size={14} className="shrink-0 text-faint" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          aria-label="Search markets"
        />
      </div>

      {q.trim().length >= 2 ? (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          <SeriesPinnedCard
            q={q}
            onPick={
              onPick && !onPickResult
                ? (ref, meta) => {
                    onPick(ref, meta);
                    setQ("");
                  }
                : undefined
            }
            onPickResult={
              onPickResult
                ? (r) => {
                    onPickResult(r);
                    setQ("");
                  }
                : undefined
            }
          />
          {search.isLoading ? (
            <div className="p-2">
              <Spinner label="Searching…" />
            </div>
          ) : search.data && search.data.results.length > 0 ? (
            search.data.results.map((event) => eventGroup(event))
          ) : (
            <p className="px-2 py-1.5 text-[12px] text-muted">No markets found for “{q}”.</p>
          )}
        </div>
      ) : (
        (idleContent ?? null)
      )}
    </div>
  );
}
