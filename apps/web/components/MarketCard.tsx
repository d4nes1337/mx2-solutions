"use client";

/**
 * Calm, Polymarket-style market card (replaces the dense terminal rows).
 * One glance: what's the market, what are the odds, one click to trade or
 * automate — plus a real backtest teaser when the showcase engine has one.
 */
import Link from "next/link";
import type { GammaEvent, GammaMarket, Showcase } from "@/lib/types";
import { cents, parseJsonArray, signedPct, signedUsd, toNum, usdCompact } from "@/lib/format";
import {
  formatResolveIn,
  marketEndMs,
  primaryMarket,
  yesProbability,
  yesTopOfBook,
} from "@/lib/feeds";
import { usePricesHistory } from "@/lib/queries";
import { LiveSparkline } from "./charts/MiniSparkline";
import { MarketHoverCard } from "./MarketHoverCard";
import { AnimatedNumber, FlashOnChange } from "./motion";
import { cn } from "./ui";

const automateHref = (event: GammaEvent, market: GammaMarket, title: string): string => {
  const tokenId = parseJsonArray(market.clobTokenIds)[0];
  const outcome = parseJsonArray(market.outcomes)[0] ?? "YES";
  const params = new URLSearchParams({ template: "re-entry" });
  if (tokenId) {
    params.set("conditionId", market.conditionId);
    params.set("tokenId", tokenId);
    params.set("outcome", outcome);
    params.set("title", title.slice(0, 120));
  }
  return `/smart-orders/new?${params.toString()}`;
};

export function MarketCard({ event, teaser }: { event: GammaEvent; teaser?: Showcase | null }) {
  const market = primaryMarket(event);
  if (!market) return null;

  const prob = yesProbability(market);
  const resolveIn = formatResolveIn(marketEndMs(market, event));
  const title = event.markets.length > 1 ? market.question : event.title;

  return (
    <MarketHoverCard
      content={
        <MarketPreviewBody event={event} market={market} prob={prob} resolveIn={resolveIn} />
      }
    >
      <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-3.5 shadow-panel transition-shadow hover:shadow-elev">
        <Link href={`/markets/${market.id}`} className="group flex-1">
          <div className="flex items-start gap-3">
            {event.icon || market.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={event.icon || market.image}
                alt=""
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div className="h-10 w-10 shrink-0 rounded-lg bg-surface-3" />
            )}
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[13px] font-medium leading-snug text-fg group-hover:text-brand-strong">
                {title}
              </div>
            </div>
            <FlashOnChange value={prob}>
              <span
                className={cn(
                  "tabular shrink-0 text-lg font-semibold leading-none",
                  prob >= 0.5 ? "text-fg" : "text-neg",
                )}
              >
                <AnimatedNumber
                  value={prob * 100}
                  duration={450}
                  format={(n) => `${n.toFixed(0)}%`}
                />
              </span>
            </FlashOnChange>
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <span className="tabular rounded-md bg-pos/10 px-2 py-1 text-[11px] font-semibold text-pos">
              Yes {cents(prob)}
            </span>
            <span className="tabular rounded-md bg-neg/10 px-2 py-1 text-[11px] font-semibold text-neg">
              No {cents(Math.max(0, 1 - prob))}
            </span>
            <span className="tabular ml-auto text-[10px] text-faint">
              {usdCompact(toNum(event.volume1wk ?? event.volume))} Vol · {resolveIn}
            </span>
          </div>
        </Link>

        <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-2.5">
          <Link
            href={automateHref(event, market, title)}
            className="text-[12px] font-semibold text-accent transition-colors hover:text-brand-strong"
          >
            Automate →
          </Link>
          {teaser ? (
            <Link
              href={`/smart-orders/new?showcase=${encodeURIComponent(teaser.id)}`}
              className="tabular rounded-full bg-pos/10 px-2 py-0.5 text-[10px] font-semibold text-pos transition-colors hover:bg-pos/20"
              title="Hypothetical 30-day backtest — past prices don't predict future prices"
            >
              dip-buy {signedUsd(teaser.stats.hypotheticalPnlUsd)}/30d
            </Link>
          ) : null}
        </div>
      </div>
    </MarketHoverCard>
  );
}

/**
 * Hover "expand": live trend chart + top-of-book depth (moved from the old
 * MarketFeedRow when the dense rows were replaced by cards).
 */
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
  const yes = yesTopOfBook(market);

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

      <div className="mt-2 h-[92px] rounded-md border border-border bg-surface-2/40 p-1">
        {history.isLoading ? (
          <div className="flex h-full items-center justify-center text-[10px] text-muted">
            Loading…
          </div>
        ) : values.length >= 2 ? (
          <LiveSparkline values={values} height={84} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted">
            No recent price history
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <DepthChip label="Yes bid" value={yes.bid > 0 ? cents(yes.bid) : "—"} tone="pos" />
        <DepthChip label="Yes ask" value={yes.ask > 0 ? cents(yes.ask) : "—"} tone="neg" />
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px]">
        <span className="tabular text-muted">
          Liq {usdCompact(toNum(market.liquidity))} · {resolveIn}
        </span>
        <span className="font-medium text-accent">Open cockpit →</span>
      </div>
    </div>
  );
}

function DepthChip({ label, value, tone }: { label: string; value: string; tone: "pos" | "neg" }) {
  return (
    <div className="rounded-md border border-border bg-surface-2/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cn(
          "tabular mt-0.5 text-xs font-semibold",
          tone === "pos" ? "text-pos" : "text-neg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
