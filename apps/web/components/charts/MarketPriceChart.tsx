"use client";

import { useState } from "react";
import { POLL, usePricesHistory } from "@/lib/queries";
import { cents, signedPct } from "@/lib/format";
import { Card, cn, LiveDot, Segmented, Skeleton } from "@/components/ui";
import { AreaChart, type ChartPoint } from "./AreaChart";

const RANGES: { value: string; label: string }[] = [
  { value: "6h", label: "6H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "max", label: "ALL" },
];

export function MarketPriceChart({
  marketId,
  outcome,
  outcomeLabel,
}: {
  marketId: string;
  outcome: number;
  outcomeLabel: string;
}) {
  const [range, setRange] = useState("1w");
  const history = usePricesHistory(marketId, {
    interval: range,
    outcome,
    refetchInterval: POLL.pricesHistory,
  });

  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const first = series[0]?.v;
  const last = series[series.length - 1]?.v;
  const changePct = first && first > 0 && last != null ? ((last - first) / first) * 100 : 0;
  const up = changePct >= 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
              {outcomeLabel} price
              <LiveDot />
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="tabular text-2xl font-semibold leading-none text-fg">
                {last != null ? cents(last) : "—"}
              </span>
              {series.length >= 2 ? (
                <span className={cn("tabular text-sm font-semibold", up ? "text-pos" : "text-neg")}>
                  {up ? "▲" : "▼"} {signedPct(changePct)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <Segmented options={RANGES} value={range} onChange={setRange} />
      </div>
      <div className="p-2 sm:p-3">
        {history.isLoading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : history.error ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-neg">
            Failed to load price history.
          </div>
        ) : series.length >= 2 ? (
          <AreaChart
            data={series}
            height={260}
            valueFormat={(v) => cents(v)}
            label={outcomeLabel}
            baseline={0.5}
          />
        ) : (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted">
            No price history available for this range.
          </div>
        )}
      </div>
    </Card>
  );
}
