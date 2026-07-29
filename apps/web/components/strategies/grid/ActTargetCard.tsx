"use client";

/**
 * The ACT zone: what fires when the conditions hold. For order actions this
 * is the target market's chart with the entry price drawn and a dollars-first
 * order summary (cost → payoff if right, fees included — "100 shares @ 57¢"
 * is a math quiz; "$57" is an answer), plus the execution-mode badge.
 *
 * Conditions never live here: they are the IF side and always render in the
 * WATCH zone, including conditions on this same market (the "watch X → trade
 * X" shape shows the market on both sides, which is what it actually is).
 *
 * One strategy = one action (StrategyDefinition.action is a single ActionV2,
 * and the whole trigger→sign→submit path is one order per trigger). Trading
 * several markets off one set of conditions is therefore several strategies;
 * the card says so and offers the duplicate path instead of pretending.
 */
import Link from "next/link";
import { Copy, Pencil, Repeat2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, Skeleton } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useMarketEconomics, useTokenPricesHistory } from "@/lib/queries";
import { marketLabel, type StrategyDoc } from "@/lib/strategies/doc";
import { cents } from "@/lib/strategies/summaries";
import { computePayoff } from "@/lib/strategies/projection";
import type { OrderActionV2 } from "@mx2/rules";

export interface ActCardEdit {
  /** Opens the shared action editor (kind switch + order params). */
  onEditAction: () => void;
  /** Clones this strategy so another market can be traded on the same logic. */
  onDuplicateForMarket?: (() => void) | undefined;
}

const usd2 = (n: number): string =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function OrderTarget({
  doc,
  action,
  range,
  markers,
  chartHeight,
  edit,
  selected,
}: {
  doc: StrategyDoc;
  action: OrderActionV2;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight: number;
  edit?: ActCardEdit | undefined;
  selected?: boolean;
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

  const baselines = [{ value: action.price, label: `entry ${cents(action.price)}` }];
  const firstT = series.length > 0 ? series[0]!.t : 0;
  const visibleMarkers = markers.filter((m) => m.t >= firstT);

  return (
    <Card className={selected ? "ring-1 ring-brand/50" : undefined}>
      <CardHeader
        right={
          action.execution === "auto" ? (
            <Badge tone="brand">AUTO · Arima Wallet</Badge>
          ) : (
            <Badge tone="neutral">You sign</Badge>
          )
        }
      >
        <span className="text-faint">Trade · </span>
        {action.rollingSeries ? (
          <span className="inline-flex items-center gap-1">
            <Repeat2 size={12} className="text-accent" aria-hidden />
            {action.rollingSeries.title ?? action.rollingSeries.seriesSlug} ·{" "}
            {action.rollingSeries.outcome}
          </span>
        ) : (
          marketLabel(doc, action.market)
        )}
      </CardHeader>
      {action.rollingSeries ? (
        <p className="px-3 pt-1.5 text-[11px] text-muted">
          Rolling: re-targets whichever window is live when this fires — never expires with one
          market.
          {action.rollingSeries.maxEntryPrice !== undefined
            ? ` Skips the window above ${cents(action.rollingSeries.maxEntryPrice)}.`
            : ""}
        </p>
      ) : null}
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
            {action.side === "BUY" ? "Buy" : "Sell"} {action.market.outcome} ·{" "}
            {usd2(payoff.costUsd)}
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
      {edit?.onDuplicateForMarket ? (
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={edit.onDuplicateForMarket}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent transition-colors hover:underline"
          >
            <Copy size={12} aria-hidden /> Trade another market on these conditions
          </button>
          <p className="mt-0.5 text-[11px] leading-snug text-faint">
            One strategy places one order. This copies the conditions into a new strategy so you can
            point it at a different market — each keeps its own spend caps.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

export function ActTargetCard({
  doc,
  range,
  markers,
  chartHeight = 210,
  edit,
  selected,
}: {
  doc: StrategyDoc;
  range: string;
  markers: { t: number; label?: string }[];
  chartHeight?: number;
  edit?: ActCardEdit | undefined;
  /** Canvas selection landed on the action node. */
  selected?: boolean;
}) {
  const action = doc.action;
  const editButton = edit ? (
    <Button variant="ghost" size="sm" onClick={edit.onEditAction}>
      <Pencil size={11} aria-hidden /> Edit action
    </Button>
  ) : null;
  const ring = selected ? "ring-1 ring-brand/50" : undefined;

  if (action.kind === "order") {
    return (
      <OrderTarget
        doc={doc}
        action={action}
        range={range}
        markers={markers}
        chartHeight={chartHeight}
        edit={edit}
        selected={selected}
      />
    );
  }
  if (action.kind === "alert") {
    return (
      <Card className={ring}>
        <CardHeader right={editButton ?? undefined}>Alert me</CardHeader>
        <p className="px-3 pb-3 pt-2 text-[13px] text-muted">
          You&apos;ll be notified when the conditions hold — no order is placed.
          {edit ? " Want it to trade instead? Edit the action." : ""}
        </p>
      </Card>
    );
  }
  if (action.kind === "stop_strategy") {
    return (
      <Card className={ring}>
        <CardHeader right={editButton ?? undefined}>Stop a strategy</CardHeader>
        <p className="px-3 pb-3 pt-2 text-[13px] text-muted">
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
    <Card className={ring}>
      <CardHeader right={editButton ?? undefined}>Maker loop</CardHeader>
      <p className="px-3 pb-3 pt-2 text-[13px] text-muted">
        Rests delta-neutral quotes while the conditions hold.
        {edit ? "" : " This action is managed on the canvas."}
      </p>
    </Card>
  );
}
