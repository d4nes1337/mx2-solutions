"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MarketFeedRow } from "@/components/MarketFeedRow";
import { Card, CardHeader, Skeleton, ErrorNote, LiveDot } from "@/components/ui";
import { useHomeFeed } from "@/lib/queries";

export function HotMarkets() {
  const home = useHomeFeed();
  const err = home.error as Error | null;
  const events = home.data?.feeds.top.events?.slice(0, 6);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Hot markets</h2>
        <LiveDot />
      </div>
      <Card>
        <CardHeader
          right={
            <Link
              href="/markets"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
            >
              See all markets <ArrowRight size={13} aria-hidden />
            </Link>
          }
        >
          Trending on Polymarket
        </CardHeader>
        <div>
          {home.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : err ? (
            <div className="p-4">
              <ErrorNote message={err.message} />
            </div>
          ) : events && events.length > 0 ? (
            events.map((e) => <MarketFeedRow key={e.id} event={e} />)
          ) : (
            <p className="p-4 text-sm text-muted">No markets available right now.</p>
          )}
        </div>
      </Card>
    </section>
  );
}
