"use client";

/**
 * Calm, card-based market feed (replaced the 3-column terminal + activity
 * tape + movers strip). One glance per market, one click to trade or
 * automate; real backtest teasers where the showcase engine has one.
 *
 * Search is server-backed: 2+ characters queries ALL of Polymarket (grouped
 * by event with sub-markets), not just the trending feed on screen.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { TradingStatusBanner } from "@/components/Banners";
import { MarketCard } from "@/components/MarketCard";
import { GroupedResultCard } from "@/components/market/GroupedResultCard";
import { Empty, ErrorNote, LiveDot, Segmented, Skeleton } from "@/components/ui";
import { useHomeFeed, useShowcases } from "@/lib/queries";
import { useGroupedMarketSearch } from "@/lib/smart-orders/queries";
import { primaryMarket } from "@/lib/feeds";
import type { GammaEvent } from "@/lib/types";

type FeedTab = "now" | "top" | "suggestedFavorites";

const TABS: { value: FeedTab; label: string }[] = [
  { value: "now", label: "Trending" },
  { value: "top", label: "Top" },
  { value: "suggestedFavorites", label: "Favorites" },
];

function MarketsFeed() {
  const params = useSearchParams();
  const paramQ = (params.get("q") ?? "").trim();
  const [q, setQ] = useState(paramQ);
  const [tab, setTab] = useState<FeedTab>("now");

  // Keep the filter in sync with ?q= navigations (e.g. hero search) that
  // happen while this page is already mounted.
  useEffect(() => setQ(paramQ), [paramQ]);
  const home = useHomeFeed();
  const sc = useShowcases();
  const err = home.error as Error | null;

  const searching = q.trim().length >= 2;
  const search = useGroupedMarketSearch(searching ? q : "");

  const events = home.data?.feeds[tab]?.events ?? [];
  const visible = events.slice(0, 18);

  const teaserFor = (event: GammaEvent) =>
    sc.data?.showcases.find((s) => s.market.conditionId === primaryMarket(event)?.conditionId) ??
    null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
          <LiveDot />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!searching ? <Segmented options={TABS} value={tab} onChange={setTab} /> : null}
          <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand">
            <Search size={13} className="shrink-0 text-faint" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search all markets…"
              aria-label="Search all markets"
              className="w-36 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint sm:w-48"
            />
          </label>
        </div>
      </div>

      <TradingStatusBanner />

      {searching ? (
        search.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full rounded-xl" />
            ))}
          </div>
        ) : search.error ? (
          <ErrorNote message={(search.error as Error).message} />
        ) : (search.data?.results.length ?? 0) > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {search.data!.results.map((event) => (
              <GroupedResultCard key={event.eventId} event={event} linkTitleToEvent />
            ))}
          </div>
        ) : (
          <Empty>No markets match “{q}” — try different words.</Empty>
        )
      ) : home.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : err ? (
        <ErrorNote message={err.message} />
      ) : visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((e) => (
            <MarketCard key={e.id} event={e} teaser={teaserFor(e)} />
          ))}
        </div>
      ) : (
        <Empty>No markets right now.</Empty>
      )}
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
