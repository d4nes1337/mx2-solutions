"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { Position } from "@/lib/types";
import { api } from "@/lib/api";
import type { MarketResolveResponse } from "@/lib/types";
import { pct, signed, toNum, usd } from "@/lib/format";
import { Badge, Empty } from "./ui";

/** Builder deep-link: trailing-stop template prefilled with this position. */
const protectHref = (p: Position): string => {
  const q = new URLSearchParams({
    template: "trailing-stop",
    conditionId: p.conditionId,
    tokenId: p.asset,
    outcome: p.outcome ?? "YES",
    size: String(Math.max(1, Math.floor(toNum(p.size)))),
  });
  if (p.title) q.set("title", p.title);
  return `/smart-orders/new?${q.toString()}`;
};

function useMarketLinks(positions: Position[]) {
  const conditionIds = useMemo(
    () => [...new Set(positions.map((p) => p.conditionId).filter(Boolean))],
    [positions],
  );

  const results = useQueries({
    queries: conditionIds.map((conditionId) => ({
      queryKey: ["market-resolve", conditionId],
      queryFn: () =>
        api.get<MarketResolveResponse>(
          `/api/markets/resolve?conditionId=${encodeURIComponent(conditionId)}`,
        ),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });

  const map = new Map<string, MarketResolveResponse>();
  conditionIds.forEach((id, i) => {
    const data = results[i]?.data;
    if (data) map.set(id, data);
  });
  return map;
}

export function PositionsTable({ positions }: { positions: Position[] }) {
  const marketLinks = useMarketLinks(positions);

  const sorted = useMemo(
    () => [...positions].sort((a, b) => Math.abs(toNum(b.cashPnl)) - Math.abs(toNum(a.cashPnl))),
    [positions],
  );

  if (positions.length === 0) {
    return (
      <Empty>
        No open positions. Polymarket keys portfolio data off your deposit wallet — use{" "}
        <strong>⚙ Wallet</strong> if you need to override the queried address.
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
            <th className="py-2 pr-3 text-right font-medium">Mark</th>
            <th className="py-2 pr-3 text-right font-medium">Value</th>
            <th className="py-2 pr-3 text-right font-medium">PnL</th>
            <th className="py-2 text-right font-medium">
              <span className="sr-only">Protect</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => {
            const pnl = toNum(p.cashPnl);
            const resolved = marketLinks.get(p.conditionId);
            const title = p.title ?? resolved?.question ?? p.conditionId;
            const href = resolved?.marketId ? `/markets/${resolved.marketId}` : null;
            const outcomeTone =
              p.outcome?.toUpperCase() === "YES"
                ? "pos"
                : p.outcome?.toUpperCase() === "NO"
                  ? "neg"
                  : "neutral";

            return (
              <tr
                key={`${p.asset}-${i}`}
                className="border-b border-border/50 transition-colors hover:bg-surface-2/50"
              >
                <td className="max-w-[280px] py-2 pr-3">
                  <div className="flex items-center gap-2">
                    {p.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.icon} alt="" className="h-5 w-5 shrink-0 rounded-sm" />
                    ) : null}
                    {href ? (
                      <Link href={href} className="truncate hover:text-accent">
                        {title}
                      </Link>
                    ) : (
                      <span className="truncate">{title}</span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  {p.outcome ? (
                    <Badge tone={outcomeTone}>{p.outcome}</Badge>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="tabular py-2 pr-3 text-right">{toNum(p.size).toFixed(2)}</td>
                <td className="tabular py-2 pr-3 text-right">{pct(p.avgPrice)}</td>
                <td className="tabular py-2 pr-3 text-right">
                  {p.curPrice != null ? pct(p.curPrice) : "—"}
                </td>
                <td className="tabular py-2 pr-3 text-right">{usd(p.currentValue)}</td>
                <td
                  className={`tabular py-2 pr-3 text-right ${pnl >= 0 ? "text-pos" : "text-neg"}`}
                >
                  ${signed(p.cashPnl)} ({signed(p.percentPnl)}%)
                </td>
                <td className="py-2 text-right">
                  {p.asset && toNum(p.size) >= 1 ? (
                    <Link
                      href={protectHref(p)}
                      title="Set a trailing stop on this position"
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-brand/50 hover:text-fg"
                    >
                      <ShieldCheck size={11} aria-hidden /> Protect
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
