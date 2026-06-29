"use client";

import { TradingStatusBanner } from "@/components/Banners";
import { FavoritesFeedColumn } from "@/components/FavoritesFeedColumn";
import { MarketFeedColumn } from "@/components/MarketFeedColumn";
import { LiveDot } from "@/components/ui";
import { useHottestFeed, useLatestFeed, useVolumeWeekFeed } from "@/lib/queries";

export default function MarketsFeedPage() {
  const latest = useLatestFeed();
  const volumeWeek = useVolumeWeekFeed();
  const hottest = useHottestFeed();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
            <LiveDot />
          </div>
          <p className="mt-1 text-xs text-muted">
            Live top-of-book across Polymarket. Hover any market for a price preview, or open the
            cockpit to trade.
          </p>
        </div>
      </div>

      <TradingStatusBanner />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MarketFeedColumn
          title="Hottest"
          subtitle="Near resolve × weekly volume"
          events={hottest.data?.events}
          isLoading={hottest.isLoading}
          error={hottest.error as Error | null}
        />
        <MarketFeedColumn
          title="Volume · 7d"
          subtitle="Most traded this week"
          events={volumeWeek.data?.events}
          isLoading={volumeWeek.isLoading}
          error={volumeWeek.error as Error | null}
        />
        <MarketFeedColumn
          title="Latest"
          subtitle="Newest listings"
          events={latest.data?.events}
          isLoading={latest.isLoading}
          error={latest.error as Error | null}
        />
        <FavoritesFeedColumn />
      </div>
    </div>
  );
}
