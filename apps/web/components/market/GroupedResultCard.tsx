"use client";

/**
 * One event-grouped search result on the Markets tab: the event header plus
 * its sub-markets (totals/spreads in a match, candidates in an election) —
 * each one tap from its market page or the builder. Multi-market events show
 * the top rows and expand in place.
 */
import { useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronDown } from "lucide-react";
import { cn } from "@/components/ui";
import { cents, usdCompact } from "@/lib/format";
import type { EventSearchResult, MarketSearchResult } from "@/lib/smart-orders/queries";

/** Rows shown before the expander (multi-market events). */
const COLLAPSED_ROWS = 4;

const automateHref = (market: MarketSearchResult, label: string): string => {
  const params = new URLSearchParams({ template: "re-entry" });
  const tokenId = market.tokenIds[0];
  if (tokenId) {
    params.set("conditionId", market.conditionId);
    params.set("tokenId", tokenId);
    params.set("outcome", market.outcomes[0] ?? "YES");
    params.set("title", label.slice(0, 120));
  }
  return `/smart-orders/new?${params.toString()}`;
};

function SubMarketRow({ event, market }: { event: EventSearchResult; market: MarketSearchResult }) {
  const label =
    market.groupItemTitle.trim() !== ""
      ? market.groupItemTitle
      : event.markets.length > 1
        ? market.title
        : event.title;
  const yes = market.outcomePrices[0];
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Link
        href={`/markets/${market.marketId}`}
        className="min-w-0 flex-1 truncate text-[13px] text-fg transition-colors hover:text-accent"
      >
        {label}
        {market.closed ? <span className="ml-1.5 text-[10px] text-faint">closed</span> : null}
      </Link>
      <span className="tabular shrink-0 text-[12px] font-semibold text-fg">
        {yes !== undefined ? cents(yes) : "—"}
      </span>
      <Link
        href={automateHref(market, `${event.title} — ${label}`)}
        className="shrink-0 text-[11px] font-semibold text-accent transition-colors hover:text-brand-strong"
      >
        Automate
      </Link>
    </div>
  );
}

export function GroupedResultCard({
  event,
  defaultExpanded = false,
  linkTitleToEvent = false,
}: {
  event: EventSearchResult;
  /** Event page: show every sub-market without the expander gate. */
  defaultExpanded?: boolean;
  /** Search/siblings contexts link the header to the event page. */
  linkTitleToEvent?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const totalVolume = event.markets.reduce((sum, m) => sum + (Number(m.volume) || 0), 0);
  const rows = expanded ? event.markets : event.markets.slice(0, COLLAPSED_ROWS);
  const hidden = event.markets.length - rows.length;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-panel">
      <div className="flex items-start gap-3">
        {event.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.image} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
        ) : null}
        <div className="min-w-0 flex-1">
          {linkTitleToEvent ? (
            <Link
              href={`/events/${event.eventId}`}
              className="text-[14px] font-semibold leading-snug text-fg transition-colors hover:text-accent"
            >
              {event.title}
            </Link>
          ) : (
            <p className="text-[14px] font-semibold leading-snug text-fg">{event.title}</p>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
            <span>
              {event.markets.length === 1
                ? "1 market"
                : `${event.markets.length} markets${event.negRisk ? " · winner-take-all" : ""}`}
            </span>
            {totalVolume > 0 ? <span>{usdCompact(totalVolume)} vol</span> : null}
            {event.endDate ? (
              <span className="inline-flex items-center gap-1">
                <CalendarDays size={11} aria-hidden />
                {new Date(event.endDate).toLocaleDateString()}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="mt-2 divide-y divide-border/60">
        {rows.map((m) => (
          <SubMarketRow key={m.marketId} event={event} market={m} />
        ))}
      </div>

      {hidden > 0 || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-fg"
        >
          <ChevronDown
            size={12}
            aria-hidden
            className={cn("transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Show fewer" : `Show all ${event.markets.length} markets`}
        </button>
      ) : null}
    </div>
  );
}
