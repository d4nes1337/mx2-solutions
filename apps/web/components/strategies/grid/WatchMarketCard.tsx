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
import { Clock, Plus, RefreshCw, Target, X } from "lucide-react";
import { Badge, Card, CardHeader, Skeleton, cn } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { LiveCaption } from "@/components/charts/LiveCaption";
import { PolymarketLink } from "@/components/PolymarketLink";
import { useTokenPricesHistory } from "@/lib/queries";
import { marketLabel, type StrategyDoc } from "@/lib/strategies/doc";
import { spliceLive } from "@/lib/strategies/live-splice";
import type { MarketFreshness } from "@/lib/strategies/queries";
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
        aria-label={
          op === "and"
            ? "Both conditions must hold. Switch to either one."
            : "Either condition can hold. Switch to both."
        }
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
  live,
  liveReceivedAtMs,
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
  /** Live book quote for this market (3s evaluation poll) — spliced onto the chart. */
  live?: MarketFreshness | undefined;
  liveReceivedAtMs?: number | undefined;
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
  // Instant-market window identity ("⟳ 5m · ends 9:25 AM"): the card
  // re-renders on the grid's live polls, so remaining time stays fresh
  // enough without its own ticker.
  const meta = tokenId !== null ? doc.marketMeta[tokenId] : undefined;
  const windowInfo = (() => {
    if (!meta?.recurrence || !meta.endDate) return null;
    const endMs = Date.parse(meta.endDate);
    if (!Number.isFinite(endMs)) return null;
    const remainingMs = endMs - Date.now();
    if (remainingMs <= 0) return { text: `${meta.recurrence} · window ended`, ended: true };
    const when =
      remainingMs < 3_600_000
        ? `ends in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m`
        : `ends ${new Date(endMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    return { text: `${meta.recurrence} · ${when}`, ended: false };
  })();
  const history = useTokenPricesHistory(tokenId, range);
  const rawSeries: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  // The chart's right edge is the live book mid (3s poll), not the last candle.
  const { series, spliced } = spliceLive(rawSeries, live, Date.now());
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
            {windowInfo ? (
              <Badge
                tone={windowInfo.ended ? "neg" : "neutral"}
                title="Recurring instant market — this strategy is bound to one window"
              >
                <RefreshCw size={9} className="mr-0.5 inline" aria-hidden />
                {windowInfo.text}
              </Badge>
            ) : null}
            {isTarget ? (
              <Badge tone="brand" title="This is also the market the order trades">
                <Target size={9} className="mr-0.5 inline" aria-hidden />
                also traded
              </Badge>
            ) : null}
            {last !== null ? (
              <span className="tabular text-[12px] text-muted">{cents(last)}</span>
            ) : null}
            <PolymarketLink conditionId={card.market?.conditionId} iconOnly />
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
            live={spliced}
            valueFormat={(v) => cents(v)}
            {...(baselines.length > 0
              ? { baselines, includeInDomain: baselines.map((b) => b.value) }
              : {})}
            {...(visibleMarkers.length > 0 ? { markers: visibleMarkers } : {})}
          />
        </div>
      ) : null}
      <LiveCaption
        quote={live}
        {...(liveReceivedAtMs ? { receivedAtMs: liveReceivedAtMs } : {})}
        className="px-3 pb-1.5 pt-0.5"
      />
      {rows}
    </Card>
  );
}
