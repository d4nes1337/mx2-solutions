"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { TradingStatusBanner } from "@/components/Banners";
import { FavoritesFeedColumn } from "@/components/FavoritesFeedColumn";
import { MarketFeedColumn } from "@/components/MarketFeedColumn";
import { ActivityTape } from "@/components/feed/ActivityTape";
import { MoversStrip } from "@/components/feed/MoversStrip";
import { LiveDot } from "@/components/ui";
import { useHomeFeed } from "@/lib/queries";
import type { GammaEvent } from "@/lib/types";

function matchesQuery(event: GammaEvent, q: string): boolean {
  const needle = q.toLowerCase();
  if (event.title?.toLowerCase().includes(needle)) return true;
  return event.markets.some((m) => m.question?.toLowerCase().includes(needle));
}

function MarketsFeed() {
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const home = useHomeFeed();
  const err = home.error as Error | null;

  const filter = (events?: GammaEvent[]) =>
    q && events ? events.filter((e) => matchesQuery(e, q)) : events;

  const now = filter(home.data?.feeds.now.events);
  const top = filter(home.data?.feeds.top.events);
  const tapeEvents = [...(now ?? []), ...(top ?? [])];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
        <LiveDot />
        {q ? (
          <span className="text-sm text-muted">
            matching “{q}”{" "}
            <a href="/markets" className="text-accent hover:underline">
              clear
            </a>
          </span>
        ) : null}
      </div>

      <ActivityTape events={tapeEvents} />

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-3.5 w-0.5 rounded-full bg-brand-strong" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Movers
          </span>
        </div>
        <MoversStrip events={now} isLoading={home.isLoading} />
      </div>

      <TradingStatusBanner />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <MarketFeedColumn title="Now" events={now} isLoading={home.isLoading} error={err} />
        <MarketFeedColumn title="Top" events={top} isLoading={home.isLoading} error={err} />
        <FavoritesFeedColumn
          events={filter(home.data?.feeds.suggestedFavorites.events)}
          isLoading={home.isLoading}
          error={err}
        />
      </div>
    </div>
  );
}

export default function MarketsPage() {
  return (
    <Suspense>
      <MarketsFeed />
    </Suspense>
  );
}
