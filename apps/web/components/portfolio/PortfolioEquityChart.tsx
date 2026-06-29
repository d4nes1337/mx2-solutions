"use client";

import { useState } from "react";
import type { EquityHistoryResponse, EquityWindow } from "@/lib/types";
import { signedUsd, usd } from "@/lib/format";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { Card, cn, ErrorNote, Segmented, Skeleton } from "@/components/ui";

const WINDOWS: { value: EquityWindow; label: string }[] = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "ALL" },
];

export function PortfolioEquityChart({
  data,
  isLoading,
  error,
  window,
  onWindow,
}: {
  data?: EquityHistoryResponse;
  isLoading?: boolean;
  error?: Error | null;
  window: EquityWindow;
  onWindow: (w: EquityWindow) => void;
}) {
  const points = data?.points ?? [];
  const series: ChartPoint[] = points.map((p) => ({ t: p.t, v: p.equity }));
  const startEquity = points[0]?.equity;
  const endEquity = points[points.length - 1]?.equity;
  const change = startEquity != null && endEquity != null ? endEquity - startEquity : undefined;
  const up = (change ?? 0) >= 0;

  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Equity (approx)</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="tabular text-xl font-semibold leading-none text-fg">
              {endEquity != null ? usd(endEquity) : "—"}
            </span>
            {change != null && series.length >= 2 ? (
              <span className={cn("tabular text-sm font-semibold", up ? "text-pos" : "text-neg")}>
                {up ? "▲" : "▼"} {signedUsd(change)}
              </span>
            ) : null}
          </div>
        </div>
        <Segmented options={WINDOWS} value={window} onChange={onWindow} />
      </div>

      <div className="space-y-2 p-3">
        {isLoading ? (
          <Skeleton className="h-[200px] w-full" />
        ) : error ? (
          <ErrorNote message={error.message} />
        ) : series.length >= 2 ? (
          <AreaChart data={series} height={200} color="var(--accent)" valueFormat={(v) => usd(v)} />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted">
            Not enough activity to chart equity.
          </div>
        )}
        {data?.disclaimer ? (
          <p className="px-1 text-[11px] leading-relaxed text-faint">ⓘ {data.disclaimer}</p>
        ) : null}
      </div>
    </Card>
  );
}

/** Controlled window state hook for the chart. */
export function useEquityWindow(defaultWindow: EquityWindow = "30d") {
  const [window, setWindow] = useState<EquityWindow>(defaultWindow);
  return { window, setWindow };
}
