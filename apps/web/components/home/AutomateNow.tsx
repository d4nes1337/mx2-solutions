"use client";

/**
 * "Automate these markets now" (Slice 6): the hottest live markets, each
 * with a best-fit strategy suggestion and a one-click Build that deep-links
 * the suggestion prompt into the cockpit — draft-first AI does the rest.
 */
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ErrorNote, LiveDot, Skeleton } from "@/components/ui";
import { useHomeFeed } from "@/lib/queries";
import { hottestScore, primaryMarket, sortEventsByScore, yesProbability } from "@/lib/feeds";
import { suggestStrategyFor, type StrategySuggestion } from "@/lib/home/suggest";
import type { GammaEvent } from "@/lib/types";

const MAX_ROWS = 6;

function MarketRow({ event, suggestion }: { event: GammaEvent; suggestion: StrategySuggestion }) {
  const market = primaryMarket(event);
  const image = market?.image || event.image;
  const priceCents = market ? Math.round(yesProbability(market) * 100) : null;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-panel">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="h-9 w-9 shrink-0 rounded-lg bg-surface-3" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="line-clamp-1 text-[13px] font-semibold leading-snug text-fg">
            {market?.question || event.title}
          </span>
          {priceCents !== null ? (
            <span className="tabular shrink-0 text-[12px] font-semibold text-fg">
              {priceCents}¢
            </span>
          ) : null}
        </div>
        <span className="inline-flex w-fit items-center rounded-full border border-brand/40 bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-accent">
          {suggestion.label}
        </span>
      </div>
      <Link
        href={`/smart-orders/new?prompt=${encodeURIComponent(suggestion.prompt)}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand bg-brand px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:border-brand-strong hover:bg-brand-strong"
      >
        <Sparkles size={12} aria-hidden />
        Build
      </Link>
    </div>
  );
}

export function AutomateNow() {
  const home = useHomeFeed();
  const err = home.error as Error | null;
  const events = home.data?.feeds.top.events ?? [];

  const rows = sortEventsByScore(events, hottestScore)
    .map((event) => ({ event, suggestion: suggestStrategyFor(event) }))
    .filter(
      (r): r is { event: GammaEvent; suggestion: StrategySuggestion } => r.suggestion !== null,
    )
    .slice(0, MAX_ROWS);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Automate these markets now</h2>
        <LiveDot />
      </div>
      {home.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : err ? (
        <ErrorNote message={err.message} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No markets available right now.</p>
      ) : (
        <div className="space-y-2">
          {rows.map(({ event, suggestion }) => (
            <MarketRow key={event.id} event={event} suggestion={suggestion} />
          ))}
        </div>
      )}
    </section>
  );
}
