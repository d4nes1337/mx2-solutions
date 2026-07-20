"use client";

/**
 * One annotated price chart per condition token: recent series, the trigger
 * threshold drawn (and kept in-domain even when off the visible range), and
 * engine-event markers so the price line explains itself. Shared by the
 * strategy detail page and the dashboard side panel — the panel swaps the
 * static threshold chip for an editable one via `renderThreshold` and
 * previews staged edits through `thresholds`.
 */
import { useState, type ReactNode } from "react";
import { Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useTokenPricesHistory } from "@/lib/queries";
import { conditionLeavesOf, docFromDefinition, marketLabel } from "@/lib/smart-orders/doc";
import { cents } from "@/lib/smart-orders/summaries";
import { humanDuration } from "@/lib/smart-orders/sentence";
import type { StrategyRow, StrategyTimeline } from "@/lib/smart-orders/queries";
import type { ConditionV2 } from "@mx2/rules";

/** Engine events → chart markers so the price line explains itself. */
const timelineMarkers = (timeline: StrategyTimeline | undefined): { t: number; label?: string }[] =>
  (timeline?.events ?? [])
    .map((e) => {
      const t = new Date(e.at).getTime();
      if (e.action === "rule.triggered") return { t, label: "T" };
      if (e.action === "rule.executed_auto") return { t, label: "$" };
      if (e.action === "rule.execution.skipped") return { t, label: "!" };
      if (
        e.action === "rule.state_changed" &&
        (e.metadata["reason"] === "STALE_PAUSED" || e.metadata["reason"] === "DATA_STALE")
      )
        return { t, label: "…" };
      return null;
    })
    .filter((m): m is { t: number; label: string } => m !== null);

const CHART_RANGES = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
];

export function ConditionCharts({
  row,
  timeline,
  thresholds,
  renderThreshold,
  height = 180,
}: {
  row: StrategyRow;
  timeline: StrategyTimeline | undefined;
  /** Staged threshold overrides by leaf id (panel quick-edit preview). */
  thresholds?: Record<string, number> | undefined;
  /** Replaces the static header chip (e.g. with an editable number). */
  renderThreshold?: ((id: string, condition: ConditionV2) => ReactNode) | undefined;
  height?: number;
}) {
  const [range, setRange] = useState("1d");
  const doc = docFromDefinition(row.definitionV2);
  const leaves = conditionLeavesOf(doc.expr).filter(
    ({ condition: c }) =>
      (c.kind === "price" || c.kind === "trailing" || c.kind === "price_move") &&
      "market" in c &&
      c.market.tokenId !== "",
  );
  // One chart per distinct token — two conditions on the same book share a chart.
  const seen = new Set<string>();
  const charts = leaves.filter(({ condition: c }) => {
    const tokenId = "market" in c ? c.market.tokenId : "";
    if (seen.has(tokenId)) return false;
    seen.add(tokenId);
    return true;
  });
  const markers = timelineMarkers(timeline);
  if (charts.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Segmented options={CHART_RANGES} value={range} onChange={setRange} size="sm" />
      </div>
      {charts.map(({ id, condition: c }) => (
        <ConditionChart
          key={id}
          leafId={id}
          doc={doc}
          condition={c}
          range={range}
          markers={markers}
          height={height}
          thresholdOverride={thresholds?.[id]}
          renderThreshold={renderThreshold}
        />
      ))}
    </div>
  );
}

function ConditionChart({
  leafId,
  doc,
  condition,
  range,
  markers,
  height,
  thresholdOverride,
  renderThreshold,
}: {
  leafId: string;
  doc: ReturnType<typeof docFromDefinition>;
  condition: ReturnType<typeof conditionLeavesOf>[number]["condition"];
  range: string;
  markers: { t: number; label?: string }[];
  height: number;
  thresholdOverride?: number | undefined;
  renderThreshold?: ((id: string, condition: ConditionV2) => ReactNode) | undefined;
}) {
  const c = condition;
  const tokenId = "market" in c ? c.market.tokenId : null;
  const threshold = c.kind === "price" ? (thresholdOverride ?? c.threshold) : null;
  const label = "market" in c ? marketLabel(doc, c.market) : "";
  const history = useTokenPricesHistory(tokenId, range);
  if (tokenId === null) return null;
  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  if (history.isLoading) return <Skeleton className="h-[180px] w-full rounded-xl" />;
  if (series.length < 2) return null;
  const firstT = series[0]!.t;
  const visibleMarkers = markers.filter((m) => m.t >= firstT);
  return (
    <Card>
      <CardHeader
        right={
          renderThreshold ? (
            renderThreshold(leafId, c)
          ) : threshold !== null ? (
            <span className="tabular text-[11px] text-muted">trigger {cents(threshold)}</span>
          ) : c.kind === "trailing" ? (
            <span className="tabular text-[11px] text-muted">
              trailing {c.mode} · {cents(c.offset)} offset
            </span>
          ) : c.kind === "price_move" ? (
            <span className="tabular text-[11px] text-muted">
              {c.direction} {cents(c.deltaThreshold)} in {humanDuration(c.windowMs)}
            </span>
          ) : undefined
        }
      >
        {label}
      </CardHeader>
      <div className="p-2">
        <AreaChart
          data={series}
          height={height}
          valueFormat={(v) => cents(v)}
          {...(threshold !== null
            ? {
                baselines: [{ value: threshold, label: cents(threshold) }],
                includeInDomain: [threshold],
              }
            : {})}
          {...(visibleMarkers.length > 0 ? { markers: visibleMarkers } : {})}
        />
      </div>
    </Card>
  );
}
