"use client";

/**
 * Real recent trades in the market (Data API taker fills) — replaces the
 * synthetic MarketMovesTape as the cockpit's default activity panel.
 */
import { useMarketTrades } from "@/lib/queries";
import { cents, shortAddress, timeAgo, usdCompact } from "@/lib/format";
import { Card, CardHeader, cn } from "@/components/ui";

export function RecentTradesCard({ marketId }: { marketId: string }) {
  const trades = useMarketTrades(marketId);
  const rows = trades.data?.trades ?? [];

  return (
    <Card>
      <CardHeader right={<span className="text-[11px] text-muted">live · taker fills</span>}>
        Latest trades
      </CardHeader>
      <div className="p-2">
        {trades.isLoading ? (
          <div className="space-y-1.5 p-2" aria-hidden>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton h-6 rounded" />
            ))}
          </div>
        ) : trades.isError ? (
          <p className="p-2 text-sm text-muted">Trade feed unavailable right now.</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-sm text-muted">No recent trades.</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-faint">
                <th className="px-2 py-1 font-medium">Trader</th>
                <th className="px-2 py-1 font-medium">Side</th>
                <th className="px-2 py-1 text-right font-medium">Price</th>
                <th className="px-2 py-1 text-right font-medium">Value</th>
                <th className="px-2 py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((t, i) => (
                <tr
                  key={`${t.transactionHash ?? i}-${t.timestamp}`}
                  className="border-t border-border/60"
                >
                  <td className="max-w-[120px] truncate px-2 py-1.5 text-fg">
                    {t.name ?? shortAddress(t.proxyWallet)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={cn(
                        "rounded-sm px-1 py-px text-[10px] font-semibold",
                        t.side === "BUY" ? "bg-pos/10 text-pos" : "bg-neg/10 text-neg",
                      )}
                    >
                      {t.side} {t.outcome ?? ""}
                    </span>
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-fg">{cents(t.price)}</td>
                  <td className="tabular px-2 py-1.5 text-right text-muted">
                    {usdCompact(t.price * t.size)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-faint">
                    {timeAgo(t.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
