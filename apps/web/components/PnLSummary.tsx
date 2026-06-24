"use client";

import type { PnlResponse } from "@/lib/types";
import { signed, usd } from "@/lib/format";
import { Card, Stat } from "./ui";

// Renders the PnL summary AND the methodology + limitations text. Surfacing
// those is a hard requirement (the backend embeds them in every response) so
// users understand what the numbers do and do not include.
export function PnLSummary({ data }: { data: PnlResponse }) {
  const s = data.summary;
  const total = parseFloat(s.totalPnl);
  const unreal = parseFloat(s.unrealizedPnl);
  const real = parseFloat(s.realizedPnl);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Portfolio value" value={usd(s.currentPortfolioValue)} />
        <Stat
          label="Total PnL"
          value={`$${signed(s.totalPnl)}`}
          tone={total >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Unrealized"
          value={`$${signed(s.unrealizedPnl)}`}
          tone={unreal >= 0 ? "pos" : "neg"}
        />
        <Stat
          label="Realized"
          value={`$${signed(s.realizedPnl)}`}
          tone={real >= 0 ? "pos" : "neg"}
        />
      </div>

      <Card className="p-3 text-xs text-muted">
        <p className="mb-1">
          <span className="font-semibold text-fg">Methodology.</span> {data.methodology}
        </p>
        <p className="font-semibold text-fg">Limitations</p>
        <ul className="ml-4 list-disc space-y-0.5">
          {data.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
