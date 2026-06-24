"use client";

import { TradingStatusBanner } from "@/components/Banners";
import { FavoritesFeedColumn } from "@/components/FavoritesFeedColumn";
import { MarketFeedColumn } from "@/components/MarketFeedColumn";
import { useHottestFeed, useLatestFeed, useVolumeWeekFeed } from "@/lib/queries";

export default function MarketsFeedPage() {
  const latest = useLatestFeed();
  const volumeWeek = useVolumeWeekFeed();
  const hottest = useHottestFeed();

  return (
    <div className="space-y-3">
      <TradingStatusBanner />
      <div className="flex items-end justify-between gap-4 border-b border-border pb-2">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wide">Market feeds</h1>
          <p className="text-[11px] text-muted">
            Top-of-book bid/ask and liquidity per outcome — no cockpit required.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-4">
        <MarketFeedColumn
          title="Latest"
          subtitle="Newest listings · 20 max"
          events={latest.data?.events}
          isLoading={latest.isLoading}
          error={latest.error as Error | null}
        />
        <MarketFeedColumn
          title="Volume (7d)"
          subtitle="Highest traded this week"
          events={volumeWeek.data?.events}
          isLoading={volumeWeek.isLoading}
          error={volumeWeek.error as Error | null}
        />
        <MarketFeedColumn
          title="Hottest"
          subtitle="Near resolve × weekly volume"
          events={hottest.data?.events}
          isLoading={hottest.isLoading}
          error={hottest.error as Error | null}
        />
        <FavoritesFeedColumn />
      </div>
    </div>
  );
}
