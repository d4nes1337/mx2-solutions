"use client";

import type { MarketPnlItem, PortfolioProfile } from "@/lib/types";
import { cents, signedPct, signedUsd, timeAgo, usd } from "@/lib/format";
import { Badge, Empty } from "@/components/ui";
import { ShareButton } from "@/components/share/ShareButton";
import { flexModelFromMarketPnl } from "@/components/share/factories";

const statusTone = (item: MarketPnlItem): "neutral" | "pos" | "neg" | "warn" => {
  if (item.status === "FLAT") return "neutral";
  if (item.pnl > 0) return "pos";
  if (item.pnl < 0) return "neg";
  return "neutral";
};

export function MarketPnlFeed({
  items,
  profile,
}: {
  items: MarketPnlItem[];
  profile?: PortfolioProfile | null;
}) {
  if (items.length === 0) {
    return <Empty>No market PnL history yet.</Empty>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 font-medium">Outcome</th>
            <th className="py-2 pr-3 text-right font-medium">PnL</th>
            <th className="py-2 pr-3 text-right font-medium">Avg</th>
            <th className="py-2 pr-3 text-right font-medium">Mark</th>
            <th className="py-2 pr-3 text-right font-medium">Exposure</th>
            <th className="py-2 pr-3 text-right font-medium">When</th>
            <th className="py-2 text-right font-medium">Card</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const tone = statusTone(item);
            const pnlTone = item.pnl >= 0 ? "text-pos" : "text-neg";
            return (
              <tr
                key={item.id}
                className="border-b border-border/50 transition-colors hover:bg-surface-2/50"
              >
                <td className="py-2 pr-3">
                  <Badge tone={tone}>{item.statusLabel}</Badge>
                </td>
                <td className="max-w-[300px] py-2 pr-3">
                  <div className="flex items-center gap-2">
                    {item.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.icon} alt="" className="h-5 w-5 shrink-0 rounded-sm" />
                    ) : null}
                    <span className="truncate">{item.title ?? item.conditionId}</span>
                  </div>
                </td>
                <td className="py-2 pr-3 text-muted">{item.outcome ?? "—"}</td>
                <td className={`tabular py-2 pr-3 text-right font-medium ${pnlTone}`}>
                  {signedUsd(item.pnl)}
                  {item.pnlPct != null ? (
                    <span className="ml-1 text-xs text-muted">({signedPct(item.pnlPct)})</span>
                  ) : null}
                </td>
                <td className="tabular py-2 pr-3 text-right">{cents(item.avgPrice)}</td>
                <td className="tabular py-2 pr-3 text-right">
                  {item.curPrice != null ? cents(item.curPrice) : "—"}
                </td>
                <td className="tabular py-2 pr-3 text-right">{usd(item.exposure)}</td>
                <td className="tabular py-2 pr-3 text-right text-muted">
                  {item.lastActivityAt ? timeAgo(item.lastActivityAt) : "open"}
                </td>
                <td className="py-2 text-right">
                  <ShareButton
                    makeModel={() => flexModelFromMarketPnl(item, profile)}
                    label="Export"
                    icon={false}
                    size="sm"
                    variant="ghost"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
