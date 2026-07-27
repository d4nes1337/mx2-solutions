"use client";

/**
 * Markets tab — a polymarket.com homepage mirror: hero search over everything,
 * category chips, and the same market grid Polymarket shows (active events,
 * volume24hr desc, via the Gamma pagination pass-through) with infinite
 * scroll. The old Trending/Top/Favorites ranked feed now serves only the home
 * surface (see ADR-0027).
 *
 * Search is server-backed: 2+ characters queries ALL of Polymarket (grouped
 * by event with sub-markets), not just the grid on screen.
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TradingStatusBanner } from "@/components/Banners";
import { BrowseGrid } from "@/components/market/BrowseGrid";
import { CategoryChips } from "@/components/market/CategoryChips";
import { GroupedResultCard } from "@/components/market/GroupedResultCard";
import { MarketsHero } from "@/components/market/MarketsHero";
import { Empty, ErrorNote, LiveDot, Skeleton } from "@/components/ui";
import { useGroupedMarketSearch } from "@/lib/strategies/queries";

function MarketsBrowse() {
  const router = useRouter();
  const params = useSearchParams();
  const paramQ = (params.get("q") ?? "").trim();
  const paramTag = params.get("tag");
  const [q, setQ] = useState(paramQ);
  const [tag, setTag] = useState<string | null>(paramTag);

  // Keep the filter in sync with ?q= navigations (e.g. hero search) that
  // happen while this page is already mounted.
  useEffect(() => setQ(paramQ), [paramQ]);

  const searching = q.trim().length >= 2;
  const search = useGroupedMarketSearch(searching ? q : "");

  const changeTag = (next: string | null) => {
    setTag(next);
    // Deep-linkable like ?q= — replace (not push) so chip-hopping doesn't
    // pollute history.
    router.replace(next ? `/markets?tag=${encodeURIComponent(next)}` : "/markets", {
      scroll: false,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Markets</h1>
        <LiveDot />
      </div>

      <MarketsHero q={q} onChange={setQ} />

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
      ) : (
        <>
          <CategoryChips tag={tag} onChange={changeTag} />
          <BrowseGrid tag={tag} />
        </>
      )}
    </div>
  );
}

export default function MarketsPage() {
  return (
    <Suspense>
      <MarketsBrowse />
    </Suspense>
  );
}
