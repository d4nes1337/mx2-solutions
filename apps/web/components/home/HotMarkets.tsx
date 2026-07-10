"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MarketCard } from "@/components/MarketCard";
import { Skeleton, ErrorNote, LiveDot } from "@/components/ui";
import { useHomeFeed, useShowcases } from "@/lib/queries";
import { primaryMarket } from "@/lib/feeds";

export function HotMarkets() {
  const home = useHomeFeed();
  const sc = useShowcases();
  const err = home.error as Error | null;
  const events = home.data?.feeds.top.events?.slice(0, 6);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight text-fg">Hot markets</h2>
          <LiveDot />
        </div>
        <Link
          href="/markets"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        >
          See all markets <ArrowRight size={13} aria-hidden />
        </Link>
      </div>
      {home.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : err ? (
        <ErrorNote message={err.message} />
      ) : events && events.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <MarketCard
              key={e.id}
              event={e}
              teaser={
                sc.data?.showcases.find(
                  (s) => s.market.conditionId === primaryMarket(e)?.conditionId,
                ) ?? null
              }
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No markets available right now.</p>
      )}
    </section>
  );
}
