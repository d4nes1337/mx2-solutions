"use client";

/**
 * Orders this strategy produced, with live fill state from the order-sync
 * loop — the missing link between "it triggered" and "did I actually get
 * filled?".
 */
import { Badge, Card, CardHeader, cn } from "@/components/ui";
import type { StrategyDoc } from "@/lib/smart-orders/doc";
import type { TimelineOrder } from "@/lib/smart-orders/queries";

const STATUS_TONE: Record<string, "neutral" | "pos" | "neg" | "warn" | "accent" | "brand"> = {
  pending: "neutral",
  submitted: "accent",
  acknowledged: "brand",
  filled: "pos",
  cancelled: "neutral",
  failed: "neg",
  unknown: "warn",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  submitted: "Submitted",
  acknowledged: "Open",
  filled: "Filled",
  cancelled: "Cancelled",
  failed: "Failed",
  unknown: "Unknown",
};

const centsOf = (v: string | null): string =>
  v === null ? "—" : `${Math.round(Number(v) * 100)}¢`;

export function LinkedOrders({ orders, doc }: { orders: TimelineOrder[]; doc: StrategyDoc }) {
  if (orders.length === 0) return null;
  const title = (tokenId: string): string =>
    doc.marketMeta[tokenId]?.title ?? `${tokenId.slice(0, 10)}…`;

  return (
    <Card>
      <CardHeader>Orders</CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-faint">
              <th className="px-4 py-2 font-medium">Side</th>
              <th className="px-2 py-2 font-medium">Size</th>
              <th className="px-2 py-2 font-medium">Price</th>
              <th className="px-2 py-2 font-medium">Filled</th>
              <th className="px-2 py-2 font-medium">Avg fill</th>
              <th className="px-4 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const size = Number(o.size);
              const filled = Number(o.filledSize);
              const fillPct =
                size > 0 && Number.isFinite(filled)
                  ? Math.min(100, Math.round((filled / size) * 100))
                  : 0;
              return (
                <tr key={o.id} className="border-b border-border last:border-b-0">
                  <td
                    className={cn(
                      "px-4 py-2 font-semibold",
                      o.side === "BUY" ? "text-pos" : "text-neg",
                    )}
                    title={title(o.tokenId)}
                  >
                    {o.side}
                  </td>
                  <td className="tabular px-2 py-2 text-fg">{o.size}</td>
                  <td className="tabular px-2 py-2 text-fg">{centsOf(o.price)}</td>
                  <td className="tabular px-2 py-2 text-muted">
                    {fillPct > 0 ? `${filled} (${fillPct}%)` : "—"}
                  </td>
                  <td className="tabular px-2 py-2 text-muted">{centsOf(o.avgFillPrice)}</td>
                  <td className="px-4 py-2 text-right">
                    <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
