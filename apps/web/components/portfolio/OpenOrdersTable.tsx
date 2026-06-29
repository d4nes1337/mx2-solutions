"use client";

import Link from "next/link";
import type { EnrichedOpenOrder } from "@/lib/types";
import { pct, toNum } from "@/lib/format";
import { Badge, Button, Empty } from "@/components/ui";

function filledPct(order: EnrichedOpenOrder): string {
  const orig = toNum(order.original_size);
  const matched = toNum(order.size_matched ?? "0");
  if (orig <= 0) return "0%";
  return `${((matched / orig) * 100).toFixed(0)}%`;
}

export function OpenOrdersTable({
  orders,
  setupRequired,
  tradingEnabled,
  onCancel,
  cancellingId,
}: {
  orders: EnrichedOpenOrder[];
  setupRequired?: boolean;
  tradingEnabled?: boolean;
  onCancel?: (clobOrderId: string) => void;
  cancellingId?: string | null;
}) {
  if (setupRequired) {
    return (
      <Empty>
        Set up trading credentials on any market page to sync live CLOB open orders.{" "}
        <Link href="/" className="text-accent hover:underline">
          Browse markets →
        </Link>
      </Empty>
    );
  }

  if (orders.length === 0) {
    return <Empty>No open orders on the CLOB for this wallet.</Empty>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 font-medium">Side</th>
            <th className="py-2 pr-3 text-right font-medium">Price</th>
            <th className="py-2 pr-3 text-right font-medium">Size</th>
            <th className="py-2 pr-3 text-right font-medium">Filled</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Placed</th>
            {tradingEnabled && onCancel ? <th className="py-2 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const title = o.title ?? o.market;
            const href = o.marketId ? `/markets/${o.marketId}` : null;
            const placed =
              o.created_at != null
                ? new Date(o.created_at * 1000).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—";

            return (
              <tr key={o.id} className="border-b border-border/50 hover:bg-surface-2/50">
                <td className="max-w-[240px] truncate py-2 pr-3">
                  {href ? (
                    <Link href={href} className="hover:text-accent">
                      {title}
                    </Link>
                  ) : (
                    title
                  )}
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={o.side === "BUY" ? "pos" : "neg"}>{o.side}</Badge>
                </td>
                <td className="tabular py-2 pr-3 text-right">{pct(o.price)}</td>
                <td className="tabular py-2 pr-3 text-right">
                  {toNum(o.original_size).toFixed(2)}
                </td>
                <td className="tabular py-2 pr-3 text-right">{filledPct(o)}</td>
                <td className="py-2 pr-3 text-xs text-muted">{o.status}</td>
                <td className="py-2 pr-3 text-xs text-muted">{placed}</td>
                {tradingEnabled && onCancel ? (
                  <td className="py-2">
                    <Button
                      variant="danger"
                      className="text-xs"
                      disabled={cancellingId === o.id}
                      onClick={() => onCancel(o.id)}
                    >
                      {cancellingId === o.id ? "…" : "Cancel"}
                    </Button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
