"use client";

import { TradingStatusBanner } from "@/components/Banners";
import { FavoritesFeedColumn } from "@/components/FavoritesFeedColumn";
import { MarketFeedColumn } from "@/components/MarketFeedColumn";
import { LiveDot } from "@/components/ui";
import { useHomeFeed } from "@/lib/queries";

export default function MarketsFeedPage() {
  const home = useHomeFeed();
  const err = home.error as Error | null;

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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <MarketFeedColumn
          title="Now"
          subtitle="New + moving + resolving soon"
          events={home.data?.feeds.now.events}
          isLoading={home.isLoading}
          error={err}
        />
        <MarketFeedColumn
          title="Top Markets"
          subtitle="Deep, active, non-extreme odds"
          events={home.data?.feeds.top.events}
          isLoading={home.isLoading}
          error={err}
        />
        <FavoritesFeedColumn
          events={home.data?.feeds.suggestedFavorites.events}
          isLoading={home.isLoading}
          error={err}
        />
      </div>
    </div>
  );
}
