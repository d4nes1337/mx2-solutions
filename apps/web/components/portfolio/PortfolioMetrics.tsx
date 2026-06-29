"use client";

import type { PnlSummary } from "@/lib/types";
import { signed, usd } from "@/lib/format";
import { Stat } from "@/components/ui";

export function PortfolioMetrics({
  summary,
  usdcBalance,
  openOrderCount,
}: {
  summary: PnlSummary;
  usdcBalance?: string | null;
  openOrderCount?: number;
}) {
  const total = parseFloat(summary.totalPnl);
  const unreal = parseFloat(summary.unrealizedPnl);
  const real = parseFloat(summary.realizedPnl);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Equity" value={usd(summary.currentPortfolioValue)} />
        <Stat
          label="Total PnL"
          value={`$${signed(summary.totalPnl)}`}
          tone={total >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Unrealized"
          value={`$${signed(summary.unrealizedPnl)}`}
          tone={unreal >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Realized"
          value={`$${signed(summary.realizedPnl)}`}
          tone={real >= 0 ? "pos" : "neg"}
        />
      </div>
      <p className="text-xs text-muted">
        {usdcBalance != null ? <>USDC {usd(usdcBalance)} · </> : null}
        {summary.openPositions} position{summary.openPositions === 1 ? "" : "s"}
        {openOrderCount != null ? (
          <>
            {" · "}
            {openOrderCount} open order{openOrderCount === 1 ? "" : "s"}
          </>
        ) : null}
      </p>
    </div>
  );
}
