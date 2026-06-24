"use client";

import Link from "next/link";
import type { GammaEvent } from "@/lib/types";
import { parseJsonArray, pct, toNum, usdCompact } from "@/lib/format";
import {
  formatResolveIn,
  marketEndMs,
  noTopOfBook,
  primaryMarket,
  yesTopOfBook,
} from "@/lib/feeds";
import { cn } from "./ui";

function OutcomeLine({
  label,
  bid,
  ask,
  liquidity,
}: {
  label: string;
  bid: number;
  ask: number;
  liquidity: number;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 text-[11px]">
      <span className="truncate text-muted">{label}</span>
      <span className="tabular text-pos" title="Best bid">
        {bid > 0 ? pct(bid) : "—"}
      </span>
      <span className="tabular text-neg" title="Best ask">
        {ask > 0 ? pct(ask) : "—"}
      </span>
      <span className="tabular text-muted" title="Order book liquidity">
        {liquidity > 0 ? usdCompact(liquidity) : "—"}
      </span>
    </div>
  );
}

export function MarketFeedRow({ event, compact }: { event: GammaEvent; compact?: boolean }) {
  const market = primaryMarket(event);
  if (!market) return null;

  const outcomes = parseJsonArray(market.outcomes);
  const yes = yesTopOfBook(market);
  const no = noTopOfBook(market);
  const liq = toNum(market.liquidity);
  const yesLabel = outcomes[0] ?? "Yes";
  const noLabel = outcomes[1] ?? "No";
  const resolveIn = formatResolveIn(marketEndMs(market, event));

  return (
    <Link
      href={`/markets/${market.id}`}
      className={cn(
        "block border-b border-border px-2 py-2 transition-colors hover:bg-surface-2",
        compact && "py-1.5",
      )}
    >
      <div className="flex items-start gap-2">
        {event.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.icon} alt="" className="mt-0.5 h-5 w-5 shrink-0 rounded-sm" />
        ) : (
          <div className="mt-0.5 h-5 w-5 shrink-0 rounded-sm bg-surface-2" />
        )}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-xs font-medium leading-snug">{event.title}</div>
          {event.markets.length > 1 ? (
            <div className="mt-0.5 line-clamp-1 text-[10px] text-muted">{market.question}</div>
          ) : null}
          <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2 text-[10px] uppercase tracking-wide text-muted/80">
            <span />
            <span>Bid</span>
            <span>Ask</span>
            <span>Liq</span>
          </div>
          <div className="mt-0.5 space-y-0.5">
            <OutcomeLine label={yesLabel} bid={yes.bid} ask={yes.ask} liquidity={liq} />
            <OutcomeLine label={noLabel} bid={no.bid} ask={no.ask} liquidity={liq} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted">
            <span>Vol {usdCompact(eventVolume(event))}</span>
            <span>·</span>
            <span>Resolves {resolveIn}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function eventVolume(event: GammaEvent): number {
  return toNum(event.volume1wk ?? event.volume);
}
