"use client";

/**
 * One watched market in the grid's WATCH zone: title + live price, a compact
 * chart with every price-type threshold drawn as a labeled line, then the
 * market's conditions as rows with live state.
 *
 * Combinators read as CONNECTORS between rows ("and"/"or" chips on the rule
 * line), not as a control in the card header — a header pill looked like it
 * governed the whole strategy. The header only carries identity: market name,
 * live price, and a "also traded" tag when this market is the order target.
 */
import { Clock, Plus, Target, X } from "lucide-react";
import { Badge, Card, CardHeader, Skeleton, cn } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useTokenPricesHistory } from "@/lib/queries";
import { marketLabel, type StrategyDoc } from "@/lib/strategies/doc";
import { cents } from "@/lib/strategies/summaries";
import type { ConditionLiveResult, WatchCard } from "@/lib/strategies/grid-projection";
import { ConditionRow } from "./ConditionRow";

export interface WatchCardEdit {
  onEditRow: (nodeId: string) => void;
  onAddCondition: () => void;
  onSetOp: (op: "and" | "or") => void;
  /** Placeholder cards only: remove the unreferenced watched market. */
  onRemove?: (() => void) | undefined;
}

/** Threshold reference lines for the price-shaped conditions on this card. */
const cardBaselines = (card: WatchCard): { value: number; label: string }[] =>
  card.rows.flatMap(({ condition: c }) =>
    c.kind === "price" ? [{ value: c.threshold, label: cents(c.threshold) }] : [],
  );

/** The and/or connector shown between two condition rows. */
function OpConnector({
  op,
  onSetOp,
}: {
  op: "and" | "or";
  onSetOp?: ((op: "and" | "or") => void) | undefined;
}) {
  const label = op === "and" ? "and" : "or";
  if (!onSetOp) {
    return (
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
          {label}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className="h-px flex-1 bg-border" />
      <button
        type="button"
        onClick={() => onSetOp(op === "and" ? "or" : "and")}
        title={op === "and" ? "Both must hold — tap for ANY" : "Either can hold — tap for ALL"}
        className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted transition-colors hover:border-brand/50 hover:text-fg"
      >
        {label}
      </button>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function WatchMarketCard({
  doc,
  card,
  results,
  range,
  markers,
  chartHeight = 150,
  edit,
  highlightIds,
  isTarget = false,
  selected = false,
  onSelect,
}: {
  doc: StrategyDoc;
  card: WatchCard;
  results: Map<string, ConditionLiveResult>;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight?: number;
  edit?: WatchCardEdit | undefined;
  highlightIds?: Set<string> | undefined;
  /** This market is also the order's target — shown on both sides. */
  isTarget?: boolean;
  /** Canvas selection landed on this card. */
  selected?: boolean;
  /** Selects this card's canvas node (header click only, so rows stay clickable). */
  onSelect?: (() => void) | undefined;
}) {
  const tokenId = card.market?.tokenId ?? null;
  const history = useTokenPricesHistory(tokenId, range);
  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const last = series.length > 0 ? series[series.length - 1]!.v : null;
  const baselines = cardBaselines(card);
  const firstT = series.length > 0 ? series[0]!.t : 0;
  const visibleMarkers = markers.filter((m) => m.t >= firstT);
  const ring = selected ? "ring-1 ring-brand/50" : undefined;

  const rows = (
    <div>
      {card.rows.map((row, i) => (
        <div key={row.nodeId}>
          {i > 0 ? <OpConnector op={card.op} onSetOp={edit?.onSetOp} /> : null}
          <ConditionRow
            doc={doc}
            row={row}
            result={results.get(row.nodeId)}
            onClick={edit ? () => edit.onEditRow(row.nodeId) : undefined}
            highlight={highlightIds?.has(row.nodeId) ?? false}
          />
        </div>
      ))}
      {card.rows.length === 0 && !edit ? (
        <div className="px-3 py-2.5 text-[12px] text-muted">No conditions on this market yet.</div>
      ) : null}
      {edit && card.key !== "time" ? (
        <button
          type="button"
          onClick={edit.onAddCondition}
          className={cn(
            "flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg",
            card.rows.length > 0 && "border-t border-border",
          )}
        >
          <Plus size={12} aria-hidden /> Add condition
        </button>
      ) : null}
    </div>
  );

  // Market-less pseudo-cards (time window / unbound placeholder).
  if (tokenId === null) {
    return (
      <Card className={ring}>
        <CardHeader>
          <span className="inline-flex items-center gap-1.5">
            {card.key === "time" ? <Clock size={12} aria-hidden /> : null}
            {card.key === "time" ? "Schedule" : "Pick a market"}
          </span>
        </CardHeader>
        {rows}
      </Card>
    );
  }

  return (
    <Card className={ring}>
      <CardHeader
        right={
          <span className="flex items-center gap-2">
            {isTarget ? (
              <Badge tone="brand" title="This is also the market the order trades">
                <Target size={9} className="mr-0.5 inline" aria-hidden />
                also traded
              </Badge>
            ) : null}
            {last !== null ? (
              <span className="tabular text-[12px] text-muted">{cents(last)}</span>
            ) : null}
            {edit?.onRemove ? (
              <button
                type="button"
                aria-label="Remove market"
                onClick={edit.onRemove}
                className="text-faint transition-colors hover:text-neg"
              >
                <X size={13} aria-hidden />
              </button>
            ) : null}
          </span>
        }
        className={onSelect ? "cursor-pointer" : undefined}
        {...(onSelect ? { onClick: onSelect } : {})}
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
      {rows}
    </Card>
  );
}
