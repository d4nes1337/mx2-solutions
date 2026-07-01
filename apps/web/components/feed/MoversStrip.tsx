"use client";

import Link from "next/link";
import type { GammaEvent } from "@/lib/types";
import { primaryMarket, yesProbability } from "@/lib/feeds";
import { signedPct } from "@/lib/format";
import { usePricesHistory } from "@/lib/queries";
import { LiveSparkline } from "../charts/MiniSparkline";
import { AnimatedNumber, FlashOnChange } from "../motion";
import { cn, Skeleton } from "../ui";

/**
 * Hero strip of live "mover" cards — the dopamine highlight above the feed.
 * Bounded to a handful so the per-card 1d history fetch stays cheap (see the
 * poll-load note in RISK_REGISTER).
 */
export function MoversStrip({ events, isLoading }: { events?: GammaEvent[]; isLoading: boolean }) {
  const movers = (events ?? []).slice(0, 8);

  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[118px] w-[220px] shrink-0" />
        ))}
      </div>
    );
  }
  if (!movers.length) return null;

  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
      {movers.map((e) => (
        <MoverCard key={e.id} event={e} />
      ))}
    </div>
  );
}

function MoverCard({ event }: { event: GammaEvent }) {
  const market = primaryMarket(event);
  const prob = market ? yesProbability(market) : 0;
  const history = usePricesHistory(market?.id ?? "", {
    interval: "1d",
    enabled: Boolean(market),
  });
  if (!market) return null;

  const values = (history.data?.history ?? []).map((p) => p.p);
  const first = values[0];
  const last = values[values.length - 1] ?? prob;
  const changePct = first && first > 0 ? ((last - first) / first) * 100 : 0;
  const up = changePct >= 0;
  const title = event.markets.length > 1 ? market.question : event.title;

  return (
    <Link
      href={`/markets/${market.id}`}
      className="sheen group relative w-[220px] shrink-0 rounded-md border border-border bg-surface p-3 transition-colors hover:border-border-strong"
    >
      <div className="flex items-center gap-2">
        {event.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.icon} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
        ) : null}
        <div className="line-clamp-1 text-[11px] font-medium text-fg">{title}</div>
      </div>

      <div className="mt-2 flex items-end justify-between">
        <FlashOnChange value={prob}>
          <span
            className={cn(
              "tabular text-2xl font-semibold leading-none",
              prob >= 0.5 ? "text-fg" : "text-neg",
            )}
          >
            <AnimatedNumber value={prob * 100} format={(n) => `${n.toFixed(0)}%`} />
          </span>
        </FlashOnChange>
        {values.length >= 2 ? (
          <span className={cn("tabular text-[11px] font-semibold", up ? "text-pos" : "text-neg")}>
            {up ? "▲" : "▼"} {signedPct(changePct)}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 h-[34px]">
        {values.length >= 2 ? (
          <LiveSparkline values={values} height={34} className="h-full w-full" />
        ) : (
          <div className="h-full" />
        )}
      </div>
    </Link>
  );
}
