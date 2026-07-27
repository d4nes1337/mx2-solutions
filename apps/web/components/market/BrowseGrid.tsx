"use client";

import { useCallback, useMemo } from "react";
import { MarketCard } from "@/components/MarketCard";
import { InfiniteSentinel } from "@/components/market/InfiniteSentinel";
import { Button, Empty, ErrorNote, Skeleton, Spinner } from "@/components/ui";
import { useBrowseEvents, useShowcases } from "@/lib/queries";
import { primaryMarket } from "@/lib/feeds";
import type { GammaEvent } from "@/lib/types";

/**
 * The Polymarket-mirror market grid: same events, same volume24hr order,
 * paged 20 at a time with an infinite-scroll sentinel (plus a manual
 * "Load more" fallback so keyboard/reader users aren't scroll-gated).
 */
export function BrowseGrid({ tag }: { tag: string | null }) {
  const browse = useBrowseEvents(tag);
  const sc = useShowcases();

  const events = useMemo(() => {
    const seen = new Set<string>();
    const out: GammaEvent[] = [];
    for (const page of browse.data?.pages ?? []) {
      for (const e of page.events) {
        // Offset paging over a live-reordering list can double-serve an event
        // across adjacent pages — keep the first occurrence only.
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    return out;
  }, [browse.data]);

  const teaserFor = (event: GammaEvent) =>
    sc.data?.showcases.find((s) => s.market.conditionId === primaryMarket(event)?.conditionId) ??
    null;

  const loadMore = useCallback(() => {
    void browse.fetchNextPage();
  }, [browse]);

  if (browse.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (browse.error && events.length === 0) {
    return (
      <div className="space-y-3">
        <ErrorNote message={(browse.error as Error).message} />
        <Button variant="ghost" size="sm" onClick={() => void browse.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (events.length === 0) {
    return <Empty>No markets in this category right now.</Empty>;
  }

  const degraded = browse.data?.pages.some((p) => p.degraded) ?? false;

  return (
    <div className="space-y-3">
      {degraded ? (
        <p className="text-[12px] text-warn">
          Live market data is briefly unavailable — showing the last good snapshot.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {events.map((e) => (
          <MarketCard key={e.id} event={e} teaser={teaserFor(e)} />
        ))}
      </div>

      {browse.isFetchingNextPage ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : null}

      <InfiniteSentinel
        onVisible={loadMore}
        disabled={!browse.hasNextPage || browse.isFetchingNextPage}
      />

      <div className="flex items-center justify-center py-1">
        {browse.isFetchNextPageError ? (
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-neg">Couldn’t load more markets.</span>
            <Button variant="ghost" size="sm" onClick={loadMore}>
              Retry
            </Button>
          </div>
        ) : browse.hasNextPage ? (
          browse.isFetchingNextPage ? (
            <Spinner label="Loading more…" />
          ) : (
            <Button variant="ghost" size="sm" onClick={loadMore}>
              Load more
            </Button>
          )
        ) : (
          <span className="text-[11px] text-faint">
            You’ve reached the end — {events.length} markets shown.
          </span>
        )}
      </div>
    </div>
  );
}
