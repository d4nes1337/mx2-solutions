"use client";

/**
 * Pinned series card — the builder-search equivalent of Polymarket's
 * "5 Minute Bitcoin Polymarkets" banner: when the query names a curated
 * crypto asset, its recurring up-or-down series (live window, countdown,
 * bindable outcomes) pin above the regular results.
 */
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import type { MarketRef } from "@mx2/rules";
import { cn } from "@/components/ui";
import type { MarketMeta } from "@/lib/strategies/doc";
import { metaFromResult, refFromResult } from "@/lib/strategies/pick";
import {
  useInstantMarkets,
  type InstantSeries,
  type InstantWindow,
  type MarketSearchResult,
} from "@/lib/strategies/queries";

const ASSET_ALIASES: Record<string, InstantSeries["asset"]> = {
  btc: "BTC",
  bitcoin: "BTC",
  eth: "ETH",
  ethereum: "ETH",
  sol: "SOL",
  solana: "SOL",
  xrp: "XRP",
  doge: "DOGE",
  dogecoin: "DOGE",
};

/** "btc 5m", "bitcoin up" … → the curated asset the query names, if any. */
export const assetFromQuery = (q: string): InstantSeries["asset"] | null => {
  for (const token of q.toLowerCase().split(/\s+/)) {
    const asset = ASSET_ALIASES[token];
    if (asset) return asset;
  }
  return null;
};

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m >= 60
    ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    : `${m}:${String(s).padStart(2, "0")}`;
};

function LiveRow({
  series,
  window: win,
  nowMs,
  onPick,
  onPickResult,
}: {
  series: InstantSeries;
  window: InstantWindow;
  nowMs: number;
  onPick?: (ref: MarketRef, meta: MarketMeta) => void;
  onPickResult?: (result: MarketSearchResult) => void;
}) {
  const remaining = Date.parse(win.endDate) - nowMs;
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shrink-0 rounded-sm bg-surface-3 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted">
        {series.cadence}
      </span>
      <span className="tabular min-w-0 flex-1 truncate text-[11px] text-fg">
        <span className="mr-1 inline-flex items-center gap-1 font-semibold text-pos">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-pos" aria-hidden />
          LIVE
        </span>
        ends in {mmss(remaining)}
      </span>
      {onPickResult ? (
        <button
          type="button"
          onClick={() => onPickResult(win.market)}
          className="shrink-0 rounded-md border border-brand/40 bg-brand-soft px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-brand-soft/70"
        >
          Use market ({win.market.outcomes.slice(0, 2).join(" + ")})
        </button>
      ) : (
        <div className="flex shrink-0 gap-1.5">
          {win.market.outcomes.slice(0, 2).map((o, i) => {
            const ref = refFromResult(win.market, i);
            if (!ref) return null;
            return (
              <button
                key={o}
                type="button"
                onClick={() =>
                  onPick?.(ref, metaFromResult(win.market, i, { endDate: win.endDate }))
                }
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                  i === 0
                    ? "border-pos/30 bg-pos/10 text-pos hover:bg-pos/20"
                    : "border-neg/30 bg-neg/10 text-neg hover:bg-neg/20",
                )}
              >
                {o}
                {win.market.outcomePrices[i]
                  ? ` · ${Math.round(Number(win.market.outcomePrices[i]) * 100)}¢`
                  : ""}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SeriesPinnedCard({
  q,
  onPick,
  onPickResult,
}: {
  q: string;
  onPick?: (ref: MarketRef, meta: MarketMeta) => void;
  onPickResult?: (result: MarketSearchResult) => void;
}) {
  const asset = assetFromQuery(q);
  const instant = useInstantMarkets(asset !== null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (asset === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [asset]);

  if (asset === null || !instant.data) return null;
  const rows = instant.data.series
    .map((series) => {
      const live = series.windows.find((w) => w.status === "live" && Date.parse(w.endDate) > nowMs);
      return series.asset === asset && live ? { series, live } : null;
    })
    .filter((r): r is { series: InstantSeries; live: InstantWindow } => r !== null);
  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-brand/40 bg-brand-soft/40 p-2">
      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
        <Zap size={11} aria-hidden />
        {asset} Up or Down — instant markets
      </p>
      <div className="mt-0.5 divide-y divide-border/40">
        {rows.map(({ series, live }) => (
          <LiveRow
            key={series.seriesSlug}
            series={series}
            window={live}
            nowMs={nowMs}
            onPick={onPick}
            onPickResult={onPickResult}
          />
        ))}
      </div>
    </div>
  );
}
