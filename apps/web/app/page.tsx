"use client";

import { TradingStatusBanner } from "@/components/Banners";
import { FavoritesFeedColumn } from "@/components/FavoritesFeedColumn";
import { MarketFeedColumn } from "@/components/MarketFeedColumn";
import { ActivityTape } from "@/components/feed/ActivityTape";
import { MoversStrip } from "@/components/feed/MoversStrip";
import { LiveDot } from "@/components/ui";
import { useHomeFeed } from "@/lib/queries";

export default function MarketsFeedPage() {
  const home = useHomeFeed();
  const err = home.error as Error | null;
  const now = home.data?.feeds.now.events;
  const top = home.data?.feeds.top.events;
  const tapeEvents = [...(now ?? []), ...(top ?? [])];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
        <LiveDot />
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
          events={home.data?.feeds.suggestedFavorites.events}
          isLoading={home.isLoading}
          error={err}
        />
      </div>
    </div>
  );
}
