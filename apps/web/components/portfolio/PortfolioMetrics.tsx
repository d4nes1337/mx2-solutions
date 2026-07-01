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
  const exposure = parseFloat(summary.exposure ?? summary.positionValue ?? "0");
  const cashRaw = summary.cashBalance ?? usdcBalance ?? null;
  const cash = cashRaw != null ? parseFloat(cashRaw) : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Equity"
          value={<Live value={equity} format={money} />}
          hint={summary.sources?.cashBalance}
        />
        <Stat
          label="Total PnL"
          tone={total >= 0 ? "pos" : "neg"}
          value={<Live value={total} format={pnl} />}
          hint={summary.sources?.totalPnl}
        />
        <Stat
          label="Unrealized"
          tone={unreal >= 0 ? "pos" : "neg"}
          value={<Live value={unreal} format={pnl} />}
          hint={summary.sources?.unrealizedPnl}
        />
        <Stat
          label="Realized"
          tone={real >= 0 ? "pos" : "neg"}
          value={<Live value={real} format={pnl} />}
          hint={summary.sources?.realizedPnl}
        />
        <Stat
          label="Exposure"
          value={<Live value={exposure} format={money} />}
          hint={summary.sources?.exposure}
        />
        <Stat
          label="Cash"
          value={cash != null ? <Live value={cash} format={money} /> : "—"}
          hint={summary.sources?.cashBalance}
        />
      </div>
      <p className="text-xs text-muted">
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
