"use client";

import type { Position } from "@/lib/types";
import { pct, signed, toNum, usd } from "@/lib/format";
import { Empty } from "./ui";

export function PositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return (
      <Empty>
        No open positions for this address. The Data API keys off your Polymarket deposit wallet —
        try the proxy-wallet override above.
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 font-medium">Outcome</th>
            <th className="py-2 pr-3 text-right font-medium">Size</th>
            <th className="py-2 pr-3 text-right font-medium">Avg</th>
            <th className="py-2 pr-3 text-right font-medium">Value</th>
            <th className="py-2 text-right font-medium">PnL</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const pnl = toNum(p.cashPnl);
            return (
              <tr key={`${p.asset}-${i}`} className="border-b border-border/50">
                <td className="max-w-[280px] truncate py-2 pr-3">{p.title ?? p.conditionId}</td>
                <td className="py-2 pr-3 text-muted">{p.outcome ?? "—"}</td>
                <td className="tabular py-2 pr-3 text-right">{toNum(p.size).toFixed(2)}</td>
                <td className="tabular py-2 pr-3 text-right">{pct(p.avgPrice)}</td>
                <td className="tabular py-2 pr-3 text-right">{usd(p.currentValue)}</td>
                <td className={`tabular py-2 text-right ${pnl >= 0 ? "text-pos" : "text-neg"}`}>
                  ${signed(p.cashPnl)} ({signed(p.percentPnl)}%)
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
