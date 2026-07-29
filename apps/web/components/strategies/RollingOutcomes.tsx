"use client";

/**
 * What a rolling strategy can win or lose, shown before it is saved (owner
 * decision, 2026-07-28 — caps stay optional, but the numbers are not).
 *
 * These markets are all-or-nothing: a window resolves to $1 or $0 a share
 * with no exit in between, so this is exact arithmetic at the price ceiling,
 * not a backtest. The only unknown is how often the call is right — which is
 * why the break-even win rate is the headline number rather than a projected
 * profit.
 */
import { modelRollingOutcomes, type OrderActionV2 } from "@mx2/rules";
import { cn } from "@/components/ui";
import { useMarketEconomics } from "@/lib/queries";

const usd = (n: number): string =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function RollingOutcomes({
  action,
  windows,
  className,
}: {
  action: OrderActionV2;
  /** Windows this strategy may trade (its repeat cap; 1 for a one-shot). */
  windows: number;
  className?: string;
}) {
  // Fetched here rather than by the parent: this component only mounts for a
  // rolling strategy, so nothing else pays for the request. The anchor shares
  // its series' fee schedule, which prices every window the strategy enters.
  const economics = useMarketEconomics(action.market.conditionId);
  const feeSchedule = economics.data?.feeSchedule ?? null;

  if (!action.rollingSeries) return null;
  const model = modelRollingOutcomes({
    shares: action.size,
    entryPrice: action.price,
    windows,
    feeSchedule,
  });

  const winRatePct = Math.round(model.breakEvenWinRate * 100);

  return (
    <div className={cn("rounded-lg border border-border bg-surface-2 p-3", className)}>
      <p className="text-[12px] font-semibold text-fg">If this runs its full course</p>
      <p className="mt-0.5 text-[11px] text-muted">
        {model.windows === 1 ? "One window" : `Up to ${model.windows} windows`} ·{" "}
        {model.shares.toLocaleString()} shares at {Math.round(model.entryPrice * 100)}¢ each
        {feeSchedule ? " · fees included" : " · fee unknown, not included"}
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-faint">Best case</dt>
          <dd className="tabular text-[14px] font-semibold text-pos">+{usd(model.bestCaseUsd)}</dd>
          <dd className="text-[10px] text-faint">every window right</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-faint">Worst case</dt>
          <dd className="tabular text-[14px] font-semibold text-neg">{usd(model.worstCaseUsd)}</dd>
          <dd className="text-[10px] text-faint">every window wrong</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-faint">Per window</dt>
          <dd className="tabular text-[12px] text-fg">
            +{usd(model.winPerWindowUsd)} / {usd(-model.lossPerWindowUsd)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-faint">Most it can spend</dt>
          <dd className="tabular text-[12px] text-fg">{usd(model.maxSpendUsd)}</dd>
        </div>
      </dl>

      <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted">
        You need to be right more than <span className="font-semibold text-fg">{winRatePct}%</span>{" "}
        of the time just to break even at this price.
      </p>
    </div>
  );
}
