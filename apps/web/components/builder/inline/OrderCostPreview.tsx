"use client";

/**
 * Design-time cost preview inside the action node: what this execution style
 * really costs on THIS market. Taker styles walk the live book (fee + price
 * impact + fillability from the official per-market fee schedule); maker
 * styles show the zero-fee path and rebate/rewards eligibility. Unknown fee
 * schedules render as "unknown" — never as zero (R-029).
 */
import { takerCrossCost, type BookLevel, type OrderActionV2 } from "@mx2/rules";
import { useMarketEconomics, useOrderbookByToken } from "@/lib/queries";
import { isBound } from "@/lib/smart-orders/doc";
import { cn } from "@/components/ui";

const money = (n: number) => `$${n.toFixed(2)}`;

function Row({ label, tone, children }: { label: string; tone?: "pos" | "warn" | "neg"; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted">{label}</span>
      <span
        className={cn(
          "tabular font-medium",
          tone === "pos" ? "text-pos" : tone === "warn" ? "text-warn" : tone === "neg" ? "text-neg" : "text-fg",
        )}
      >
        {children}
      </span>
    </div>
  );
}

const toLevels = (raw: { price: string; size: string }[] | undefined): BookLevel[] =>
  (raw ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));

export function OrderCostPreview({ action }: { action: OrderActionV2 }) {
  const bound = isBound(action.market);
  const economics = useMarketEconomics(bound ? action.market.conditionId : "");
  const book = useOrderbookByToken(
    bound ? action.market.conditionId : "",
    bound ? action.market.tokenId : null,
  );
  if (!bound) return null;

  const schedule = economics.data?.feeSchedule ?? null;
  const rewards = economics.data?.rewards ?? null;
  const isTaker = action.orderType === "FOK" || action.orderType === "FAK";
  const feeKnown = economics.data !== undefined && schedule !== null;

  if (isTaker) {
    const levels = toLevels(action.side === "BUY" ? book.data?.asks : book.data?.bids);
    const cost =
      levels.length > 0
        ? takerCrossCost(levels, action.side, action.price, action.size, schedule)
        : null;
    return (
      <div className="space-y-1 rounded-lg border border-border bg-surface-2/60 p-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Immediate execution cost
        </p>
        {cost ? (
          <>
            <Row
              label="Fillable now"
              tone={cost.fillableShares < action.size ? "warn" : undefined}
            >
              {Math.floor(cost.fillableShares)} / {action.size} shares
            </Row>
            {cost.fillableShares > 0 ? (
              <>
                <Row label="Avg fill price">{Math.round(cost.avgPrice * 100)}¢</Row>
                <Row label="Price impact">{money(cost.impactUsd)}</Row>
              </>
            ) : null}
            <Row label="Taker fee" tone={feeKnown ? undefined : "warn"}>
              {feeKnown
                ? schedule.rate === 0
                  ? "$0 (fee-free market)"
                  : money(cost.feeUsd)
                : "unknown"}
            </Row>
            {action.orderType === "FOK" && cost.fillableShares < action.size ? (
              <p className="text-[10px] leading-snug text-neg">
                All-or-nothing would be rejected right now — the book can&apos;t fill the full
                size at your price.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[11px] text-muted">
            Order book unavailable — cost can&apos;t be estimated right now.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface-2/60 p-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Resting (maker) economics
      </p>
      <Row label="Trading fee" tone="pos">
        $0 — makers pay nothing
      </Row>
      {schedule?.rebateRate != null && schedule.rate > 0 ? (
        <Row label="Maker rebates" tone="pos">
          {Math.round(schedule.rebateRate * 100)}% of taker fees, pro-rata
        </Row>
      ) : null}
      {rewards?.ratePerDayUsd != null ? (
        <Row label="Rewards pool">≈{money(rewards.ratePerDayUsd)}/day (shared)</Row>
      ) : null}
      {action.postOnly ? (
        <p className="text-[10px] leading-snug text-muted">
          Post-only: the exchange rejects the order instead of crossing the spread.
        </p>
      ) : null}
    </div>
  );
}
