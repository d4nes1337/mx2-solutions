"use client";

/**
 * One watched market in the grid's WATCH zone: title + live price, a compact
 * chart with every price-type threshold drawn as a labeled line, then the
 * market's conditions as rows with live state. When the card carries more
 * than one condition its own ALL/ANY combinator is shown — the visual
 * grouping always tells the truth about the logic (two-level tree).
 */
import { Clock } from "lucide-react";
import { Badge, Card, CardHeader, Skeleton } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useTokenPricesHistory } from "@/lib/queries";
import { marketLabel, type StrategyDoc } from "@/lib/strategies/doc";
import { cents } from "@/lib/strategies/summaries";
import type { ConditionLiveResult, WatchCard } from "@/lib/strategies/grid-projection";
import { ConditionRow } from "./ConditionRow";

/** Threshold reference lines for the price-shaped conditions on this card. */
const cardBaselines = (card: WatchCard): { value: number; label: string }[] =>
  card.rows.flatMap(({ condition: c }) =>
    c.kind === "price" ? [{ value: c.threshold, label: cents(c.threshold) }] : [],
  );

const opLabel = (op: "and" | "or"): string => (op === "and" ? "ALL" : "ANY");

export function WatchMarketCard({
  doc,
  card,
  results,
  range,
  markers,
  chartHeight = 150,
}: {
  doc: StrategyDoc;
  card: WatchCard;
  results: Map<string, ConditionLiveResult>;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight?: number;
}) {
  const tokenId = card.market?.tokenId ?? null;
  const history = useTokenPricesHistory(tokenId, range);
  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const last = series.length > 0 ? series[series.length - 1]!.v : null;
  const baselines = cardBaselines(card);
  const firstT = series.length > 0 ? series[0]!.t : 0;
  const visibleMarkers = markers.filter((m) => m.t >= firstT);

  // Market-less pseudo-cards (time window / unbound placeholder).
  if (tokenId === null) {
    return (
      <Card>
        <CardHeader
          right={card.rows.length > 1 ? <Badge tone="neutral">{opLabel(card.op)}</Badge> : undefined}
        >
          <span className="inline-flex items-center gap-1.5">
            {card.key === "time" ? <Clock size={12} aria-hidden /> : null}
            {card.key === "time" ? "Schedule" : "Pick a market"}
          </span>
        </CardHeader>
        <div className="divide-y divide-border">
          {card.rows.map((row) => (
            <ConditionRow key={row.nodeId} doc={doc} row={row} result={results.get(row.nodeId)} />
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        right={
          <span className="flex items-center gap-2">
            {last !== null ? <span className="tabular text-[12px] text-muted">{cents(last)}</span> : null}
            {card.rows.length > 1 ? <Badge tone="neutral">{opLabel(card.op)}</Badge> : null}
          </span>
        }
      >
        {card.market ? marketLabel(doc, card.market) : "Market"}
      </CardHeader>
      {history.isLoading ? (
        <div className="p-2" style={{ height: chartHeight + 8 }}>
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      ) : series.length >= 2 ? (
        <div className="p-2 pb-0">
          <AreaChart
            data={series}
            height={chartHeight}
            valueFormat={(v) => cents(v)}
            {...(baselines.length > 0
              ? { baselines, includeInDomain: baselines.map((b) => b.value) }
              : {})}
            {...(visibleMarkers.length > 0 ? { markers: visibleMarkers } : {})}
          />
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {card.rows.map((row) => (
          <ConditionRow key={row.nodeId} doc={doc} row={row} result={results.get(row.nodeId)} />
        ))}
        {card.rows.length === 0 ? (
          <div className="px-3 py-2.5 text-[12px] text-muted">No conditions on this market yet.</div>
        ) : null}
      </div>
    </Card>
  );
}
