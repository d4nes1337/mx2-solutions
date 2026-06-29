"use client";

import Link from "next/link";
import type { GammaEvent, GammaMarket } from "@/lib/types";
import { cents, parseJsonArray, pct, signedPct, toNum, usdCompact } from "@/lib/format";
import {
  formatResolveIn,
  marketEndMs,
  primaryMarket,
  yesProbability,
  yesTopOfBook,
} from "@/lib/feeds";
import { usePricesHistory } from "@/lib/queries";
import { MiniSparkline } from "./charts/MiniSparkline";
import { MarketHoverCard } from "./MarketHoverCard";
import { cn } from "./ui";

function ProbBar({ prob }: { prob: number }) {
  const p = Math.max(0, Math.min(1, prob));
  const wide = p >= 0.5;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${p * 100}%`,
            background: wide ? "var(--brand-strong)" : "var(--neg)",
          }}
        />
      </div>
      <span
        className={cn(
          "tabular w-12 shrink-0 text-right text-xs font-semibold",
          wide ? "text-fg" : "text-neg",
        )}
      >
        {cents(prob)}
      </span>
    </div>
  );
}

export function MarketFeedRow({ event, compact }: { event: GammaEvent; compact?: boolean }) {
  const market = primaryMarket(event);
  if (!market) return null;

  const yes = yesTopOfBook(market);
  const prob = yesProbability(market);
  const liq = toNum(market.liquidity);
  const resolveIn = formatResolveIn(marketEndMs(market, event));
  const spread = yes.bid > 0 && yes.ask > 0 ? yes.ask - yes.bid : 0;

  return (
    <MarketHoverCard
      className="border-b border-border/70 last:border-0"
      content={
        <MarketPreviewBody event={event} market={market} prob={prob} resolveIn={resolveIn} />
      }
    >
      <Link
        href={`/markets/${market.id}`}
        className={cn(
          "group block px-3 py-2.5 transition-colors hover:bg-surface-2/70",
          compact && "py-2",
        )}
      >
        <div className="flex items-start gap-2.5">
          {event.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={event.icon}
              alt=""
              className="mt-0.5 h-7 w-7 shrink-0 rounded-md object-cover"
            />
          ) : (
            <div className="mt-0.5 h-7 w-7 shrink-0 rounded-md bg-surface-3" />
          )}
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-medium leading-snug text-fg group-hover:text-white">
              {event.markets.length > 1 ? market.question : event.title}
            </div>

            <div className="mt-2">
              <ProbBar prob={prob} />
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted">
              <span className="tabular">
                <span className="text-pos">{yes.bid > 0 ? pct(yes.bid) : "—"}</span>
                <span className="px-1 text-faint">/</span>
                <span className="text-neg">{yes.ask > 0 ? pct(yes.ask) : "—"}</span>
                {spread > 0 ? (
                  <span className="ml-1.5 text-faint">spr {(spread * 100).toFixed(1)}</span>
                ) : null}
              </span>
              <span className="tabular flex items-center gap-2">
                <span title="Order book liquidity">Liq {liq > 0 ? usdCompact(liq) : "—"}</span>
              </span>
            </div>

            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-faint">
              <span className="tabular">Vol {usdCompact(eventVolume(event))}</span>
              <span className="tabular">Resolves {resolveIn}</span>
            </div>
          </div>
        </div>
      </Link>
    </MarketHoverCard>
  );
}

function MarketPreviewBody({
  event,
  market,
  prob,
  resolveIn,
}: {
  event: GammaEvent;
  market: GammaMarket;
  prob: number;
  resolveIn: string;
}) {
  const history = usePricesHistory(market.id, {
    interval: "1w",
    enabled: true,
    refetchInterval: undefined,
  });
  const series = history.data?.history ?? [];
  const values = series.map((p) => p.p);
  const first = values[0];
  const last = values[values.length - 1] ?? prob;
  const changePct = first && first > 0 ? ((last - first) / first) * 100 : 0;
  const up = changePct >= 0;

  const outcomes = parseJsonArray(market.outcomes);
  const yesLabel = outcomes[0] ?? "Yes";

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        {event.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.icon} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
        ) : null}
        <div className="line-clamp-2 text-xs font-medium leading-snug text-fg">
          {event.markets.length > 1 ? market.question : event.title}
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted">{yesLabel} price</div>
          <div className="tabular text-2xl font-semibold leading-none text-fg">{cents(last)}</div>
        </div>
        <div className={cn("tabular text-xs font-semibold", up ? "text-pos" : "text-neg")}>
          {up ? "▲" : "▼"} {signedPct(changePct)} <span className="text-faint">1w</span>
        </div>
      </div>

      <div className="mt-2 h-[64px] rounded-md border border-border bg-surface-2/50 p-1">
        {history.isLoading ? (
          <div className="flex h-full items-center justify-center text-[10px] text-muted">
            Loading…
          </div>
        ) : values.length >= 2 ? (
          <MiniSparkline values={values} width={296} height={56} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted">
            No recent price history
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <PreviewStat label="Volume" value={usdCompact(eventVolume(event))} />
        <PreviewStat label="Liquidity" value={usdCompact(toNum(market.liquidity))} />
        <PreviewStat label="Resolves" value={resolveIn} />
      </div>
    </div>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2/50 px-1.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-0.5 text-[11px] font-semibold text-fg">{value}</div>
    </div>
  );
}

function eventVolume(event: GammaEvent): number {
  return toNum(event.volume1wk ?? event.volume);
}
