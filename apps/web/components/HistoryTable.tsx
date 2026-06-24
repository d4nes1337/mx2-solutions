"use client";

import type { Activity } from "@/lib/types";
import { pct, timeAgo, toNum, usd } from "@/lib/format";
import { Badge, Empty } from "./ui";

export function HistoryTable({ activity }: { activity: Activity[] }) {
  if (activity.length === 0) {
    return <Empty>No recent activity for this address.</Empty>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 text-right font-medium">Price</th>
            <th className="py-2 text-right font-medium">USDC</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((a, i) => (
            <tr key={a.transactionHash ?? i} className="border-b border-border/50">
              <td className="py-2 pr-3 text-muted">{timeAgo(a.timestamp)}</td>
              <td className="py-2 pr-3">
                <Badge tone={a.side === "BUY" ? "pos" : a.side === "SELL" ? "neg" : "neutral"}>
                  {a.type}
                  {a.side ? ` ${a.side}` : ""}
                </Badge>
              </td>
              <td className="max-w-[260px] truncate py-2 pr-3">{a.title ?? "—"}</td>
              <td className="tabular py-2 pr-3 text-right">{a.price ? pct(a.price) : "—"}</td>
              <td className="tabular py-2 text-right">{usd(toNum(a.usdcSize))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
