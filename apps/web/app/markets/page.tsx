"use client";

/**
 * Calm, card-based market feed (replaced the 3-column terminal + activity
 * tape + movers strip). One glance per market, one click to trade or
 * automate; real backtest teasers where the showcase engine has one.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { TradingStatusBanner } from "@/components/Banners";
import { MarketCard } from "@/components/MarketCard";
import { Empty, ErrorNote, LiveDot, Segmented, Skeleton } from "@/components/ui";
import { useHomeFeed, useShowcases } from "@/lib/queries";
import { primaryMarket } from "@/lib/feeds";
import type { GammaEvent } from "@/lib/types";

type FeedTab = "now" | "top" | "suggestedFavorites";

const TABS: { value: FeedTab; label: string }[] = [
  { value: "now", label: "Trending" },
  { value: "top", label: "Top" },
  { value: "suggestedFavorites", label: "Favorites" },
];

function matchesQuery(event: GammaEvent, q: string): boolean {
  const needle = q.toLowerCase();
  if (event.title?.toLowerCase().includes(needle)) return true;
  return event.markets.some((m) => m.question?.toLowerCase().includes(needle));
}

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

  const events = home.data?.feeds[tab]?.events ?? [];
  const filtered = q.trim() ? events.filter((e) => matchesQuery(e, q.trim())) : events;
  const visible = filtered.slice(0, 18);

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
          <Segmented options={TABS} value={tab} onChange={setTab} />
          <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 focus-within:border-brand">
            <Search size={13} className="shrink-0 text-faint" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter markets…"
              aria-label="Filter markets"
              className="w-36 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint sm:w-48"
            />
          </label>
        </div>
      </div>

      <TradingStatusBanner />

      {home.isLoading ? (
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
        <Empty>
          {q ? `No markets match “${q}” — try a shorter search.` : "No markets right now."}
        </Empty>
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
