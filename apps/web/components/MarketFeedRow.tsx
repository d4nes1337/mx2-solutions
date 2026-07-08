"use client";

import Link from "next/link";
import type { GammaEvent, GammaMarket } from "@/lib/types";
import { cents, parseJsonArray, signedPct, toNum, usdCompact } from "@/lib/format";
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

/** Thin, purely-visual probability bar (the precise value is shown as the %). */
function ProbBar({ prob }: { prob: number }) {
  const p = Math.max(0, Math.min(1, prob));
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-snap"
        style={{
          width: `${p * 100}%`,
          background: p >= 0.5 ? "var(--brand-strong)" : "var(--neg)",
        }}
      />
    </div>
  );
}

export function MarketFeedRow({ event, compact }: { event: GammaEvent; compact?: boolean }) {
  const market = primaryMarket(event);
  if (!market) return null;

  const prob = yesProbability(market);
  const yesC = prob;
  const noC = Math.max(0, 1 - prob);
  const resolveIn = formatResolveIn(marketEndMs(market, event));
  const title = event.markets.length > 1 ? market.question : event.title;
  const signal = topReason(event);

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
          "group block px-3 py-2.5 transition-colors hover:bg-surface-2/60",
          compact && "py-2",
        )}
      >
        <div className="flex items-center gap-3">
          {event.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.icon} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
          ) : (
            <div className="h-8 w-8 shrink-0 rounded-md bg-surface-3" />
          )}

          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-medium leading-snug text-fg group-hover:text-brand-strong">
              {title}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-faint">
              <span className="tabular">{usdCompact(eventVolume(event))} Vol</span>
              <span aria-hidden>·</span>
              <span className="tabular">{resolveIn}</span>
              {signal ? (
                <span className="rounded-sm border border-border bg-surface-2 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted">
                  {signal}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <FlashOnChange value={prob}>
              <span
                className={cn(
                  "tabular text-lg font-semibold leading-none",
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
            <div className="flex items-center gap-1 text-[10px]">
              <span className="tabular rounded-sm bg-pos/10 px-1 py-px font-medium text-pos">
                Y {cents(yesC)}
              </span>
              <span className="tabular rounded-sm bg-neg/10 px-1 py-px font-medium text-neg">
                N {cents(noC)}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-2">
          <ProbBar prob={prob} />
        </div>
      </Link>
    </MarketHoverCard>
  );
}

/**
 * Hover "expand": the deeper look you don't get in the dense row — a live trend
 * chart and top-of-book depth. Deliberately does NOT repeat the row's Vol/Resolves.
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

function eventVolume(event: GammaEvent): number {
  return toNum(event.volume1wk ?? event.volume);
}

/** At most one signal label per row (was up to three badges). */
function topReason(event: GammaEvent): string | null {
  const meta = event["_feed"] as { reasons?: unknown } | undefined;
  const reasons = Array.isArray(meta?.reasons)
    ? meta.reasons.filter((r): r is string => typeof r === "string")
    : [];
  const first = reasons[0];
  if (!first) return null;
  const labels: Record<string, string> = {
    active: "Active",
    balanced: "Live odds",
    competitive: "Hot",
    featured: "Featured",
    fresh: "Fresh",
    liquid: "Liquid",
    soon: "Soon",
    tight: "Tight",
    volume: "Volume",
  };
  return labels[first] ?? first;
}
