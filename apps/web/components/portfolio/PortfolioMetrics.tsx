"use client";

import type { PnlSummary } from "@/lib/types";
import { signed, usd } from "@/lib/format";
import { Stat } from "@/components/ui";
import { AnimatedNumber, FlashOnChange } from "@/components/motion";

// AnimatedNumber (no `mountFrom`) renders the final value on first paint, so the
// pinned test strings ("$100.00", "$+7.78") are produced immediately; the tween
// only shows in the browser on subsequent updates.
const money = (n: number) => usd(n);
const pnl = (n: number) => `$${signed(n)}`;

function Live({ value, format }: { value: number; format: (n: number) => string }) {
  return (
    <FlashOnChange value={value}>
      <AnimatedNumber value={value} format={format} />
    </FlashOnChange>
  );
}

export function PortfolioMetrics({
  summary,
  usdcBalance,
  openOrderCount,
}: {
  summary: PnlSummary;
  usdcBalance?: string | null;
  openOrderCount?: number;
}) {
  const equity = parseFloat(summary.currentPortfolioValue);
  const total = parseFloat(summary.totalPnl);
  const unreal = parseFloat(summary.unrealizedPnl);
  const real = parseFloat(summary.realizedPnl);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Equity" value={<Live value={equity} format={money} />} />
        <Stat
          label="Total PnL"
          tone={total >= 0 ? "pos" : "neg"}
          value={<Live value={total} format={pnl} />}
        />
        <Stat
          label="Unrealized"
          tone={unreal >= 0 ? "pos" : "neg"}
          value={<Live value={unreal} format={pnl} />}
        />
        <Stat
          label="Realized"
          tone={real >= 0 ? "pos" : "neg"}
          value={<Live value={real} format={pnl} />}
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
