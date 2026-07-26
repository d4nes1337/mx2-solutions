"use client";

/**
 * The ACT zone: what fires when the conditions hold. For order actions this
 * is the target market's chart with the entry price drawn, a dollars-first
 * order summary (cost → payoff if right, fees included — "100 shares @ 57¢"
 * is a math quiz; "$57" is an answer), the execution-mode badge, and any
 * guard conditions bound to the target market itself.
 */
import Link from "next/link";
import { Pencil, Plus } from "lucide-react";
import { Badge, Button, Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useMarketEconomics, useTokenPricesHistory } from "@/lib/queries";
import { isBound, marketLabel, type StrategyDoc } from "@/lib/strategies/doc";
import { cents } from "@/lib/strategies/summaries";
import { computePayoff } from "@/lib/strategies/projection";
import type { ConditionLiveResult, GridRow } from "@/lib/strategies/grid-projection";
import type { OrderActionV2 } from "@mx2/rules";
import { ConditionRow } from "./ConditionRow";

export interface ActCardEdit {
  /** Opens the shared action editor (kind switch + order params). */
  onEditAction: () => void;
  /** Adds a condition bound to the target market (a guard row). */
  onAddGuard: () => void;
  onEditRow: (nodeId: string) => void;
  onSetGuardsOp: (op: "and" | "or") => void;
}

const usd2 = (n: number): string =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const OP_OPTIONS = [
  { value: "and", label: "ALL" },
  { value: "or", label: "ANY" },
];

function OrderTarget({
  doc,
  action,
  guards,
  guardsOp,
  results,
  range,
  markers,
  chartHeight,
  edit,
  highlightIds,
}: {
  doc: StrategyDoc;
  action: OrderActionV2;
  guards: GridRow[];
  guardsOp: "and" | "or";
  results: Map<string, ConditionLiveResult>;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight: number;
  edit?: ActCardEdit | undefined;
  highlightIds?: Set<string> | undefined;
}) {
  const tokenId = action.market.tokenId || null;
  const history = useTokenPricesHistory(tokenId, range);
  const economics = useMarketEconomics(action.market.conditionId);
  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const last = series.length > 0 ? series[series.length - 1]!.v : null;

  const payoff = computePayoff({
    side: action.side,
    price: action.price,
    size: action.size,
    tokenId: action.market.tokenId,
    outcome: action.market.outcome,
    currentPrice: last,
    hypothetical: false,
    takerEntry: action.orderType === "FOK" || action.orderType === "FAK",
    feeSchedule: economics.data?.feeSchedule ?? null,
  });

  const baselines = [
    { value: action.price, label: `entry ${cents(action.price)}` },
    ...guards.flatMap(({ condition: c }) =>
      c.kind === "price" ? [{ value: c.threshold, label: cents(c.threshold) }] : [],
    ),
  ];
  const firstT = series.length > 0 ? series[0]!.t : 0;
  const visibleMarkers = markers.filter((m) => m.t >= firstT);

  return (
    <Card>
      <CardHeader
        right={
          action.execution === "auto" ? (
            <Badge tone="brand">AUTO · Arima Wallet</Badge>
          ) : (
            <Badge tone="neutral">You sign</Badge>
          )
        }
      >
        <span className="text-faint">Target · </span>
        {marketLabel(doc, action.market)}
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
            baselines={baselines}
            includeInDomain={baselines.map((b) => b.value)}
            {...(visibleMarkers.length > 0 ? { markers: visibleMarkers } : {})}
          />
        </div>
      ) : null}
      <div className="space-y-1 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-semibold text-fg">
            {action.side === "BUY" ? "Buy" : "Sell"} {action.market.outcome} · {usd2(payoff.costUsd)}
          </span>
          <span className="tabular text-[13px] font-medium text-pos">
            +{usd2(payoff.payoffIfWinUsd)} if right
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-muted">
            at {cents(action.price)} limit · {action.size.toLocaleString()} shares ·{" "}
            {action.orderType}
            {payoff.entryFeeUsd > 0 ? ` · fee ${usd2(payoff.entryFeeUsd)}` : ""}
          </span>
          {edit ? (
            <Button variant="ghost" size="sm" onClick={edit.onEditAction}>
              <Pencil size={11} aria-hidden /> Edit order
            </Button>
          ) : null}
        </div>
      </div>
      {guards.length > 0 || edit ? (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 pb-0.5 pt-2">
            <span className="text-micro font-semibold uppercase tracking-wider text-faint">
              Only if
            </span>
            {guards.length > 1 ? (
              edit ? (
                <Segmented
                  options={OP_OPTIONS}
                  value={guardsOp}
                  onChange={(v) => edit.onSetGuardsOp(v as "and" | "or")}
                  size="sm"
                />
              ) : (
                <Badge tone="neutral">{guardsOp === "and" ? "ALL" : "ANY"}</Badge>
              )
            ) : null}
          </div>
          <div className="divide-y divide-border">
            {guards.map((row) => (
              <ConditionRow
                key={row.nodeId}
                doc={doc}
                row={row}
                result={results.get(row.nodeId)}
                onClick={edit ? () => edit.onEditRow(row.nodeId) : undefined}
                highlight={highlightIds?.has(row.nodeId) ?? false}
              />
            ))}
            {edit && isBound(action.market) ? (
              <button
                type="button"
                onClick={edit.onAddGuard}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <Plus size={12} aria-hidden /> Add guard on the target
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function ActTargetCard({
  doc,
  guards,
  guardsOp,
  results,
  range,
  markers,
  chartHeight = 210,
  edit,
  highlightIds,
}: {
  doc: StrategyDoc;
  guards: GridRow[];
  guardsOp: "and" | "or";
  results: Map<string, ConditionLiveResult>;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight?: number;
  edit?: ActCardEdit | undefined;
  highlightIds?: Set<string> | undefined;
}) {
  const action = doc.action;
  const editButton = edit ? (
    <Button variant="ghost" size="sm" onClick={edit.onEditAction}>
      <Pencil size={11} aria-hidden /> Edit action
    </Button>
  ) : null;
  if (action.kind === "order") {
    return (
      <OrderTarget
        doc={doc}
        action={action}
        guards={guards}
        guardsOp={guardsOp}
        results={results}
        range={range}
        markers={markers}
        chartHeight={chartHeight}
        edit={edit}
        highlightIds={highlightIds}
      />
    );
  }
  if (action.kind === "alert") {
    return (
      <Card>
        <CardHeader right={editButton ?? undefined}>Alert</CardHeader>
        <p className="px-3 pb-3 text-[13px] text-muted">
          You&apos;ll be notified when the conditions hold — no order is placed.
          {edit ? " Want it to trade instead? Edit the action." : ""}
        </p>
      </Card>
    );
  }
  if (action.kind === "stop_strategy") {
    return (
      <Card>
        <CardHeader right={editButton ?? undefined}>Stop a strategy</CardHeader>
        <p className="px-3 pb-3 text-[13px] text-muted">
          Stops{" "}
          <Link
            href={`/strategies/${action.targetStrategyId}`}
            className="text-accent hover:underline"
          >
            another strategy
          </Link>{" "}
          when the conditions hold.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader right={editButton ?? undefined}>Maker loop</CardHeader>
      <p className="px-3 pb-3 text-[13px] text-muted">
        Rests delta-neutral quotes while the conditions hold.
        {edit ? "" : " This action is managed on the canvas."}
      </p>
    </Card>
  );
}
