"use client";

import type { Activity, HistoryTypeFilter } from "@/lib/types";
import { pct, timeAgo, toNum, usd } from "@/lib/format";
import { Badge, Button, cn, Empty } from "./ui";

const POLYGONSCAN_TX = "https://polygonscan.com/tx/";

export function HistoryFilters({
  value,
  onChange,
}: {
  value: HistoryTypeFilter;
  onChange: (v: HistoryTypeFilter) => void;
}) {
  const filters: { id: HistoryTypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "trade", label: "Trades" },
    { id: "redeem", label: "Redeem" },
    { id: "other", label: "Other" },
  ];
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {filters.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onChange(f.id)}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px]",
            value === f.id
              ? "border-accent/50 text-accent"
              : "border-border text-muted hover:text-fg",
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

export function HistoryTable({ activity }: { activity: Activity[] }) {
  if (activity.length === 0) {
    return <Empty>No activity for this filter.</Empty>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 font-medium">Outcome</th>
            <th className="py-2 pr-3 text-right font-medium">Price</th>
            <th className="py-2 pr-3 text-right font-medium">Size</th>
            <th className="py-2 text-right font-medium">USDC</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((a, i) => (
            <tr
              key={a.transactionHash ?? `${a.timestamp}-${i}`}
              className="border-b border-border/50"
            >
              <td className="py-2 pr-3 text-muted">
                {a.transactionHash ? (
                  <a
                    href={`${POLYGONSCAN_TX}${a.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-accent"
                    title={a.transactionHash}
                  >
                    {timeAgo(a.timestamp)}
                  </a>
                ) : (
                  timeAgo(a.timestamp)
                )}
              </td>
              <td className="py-2 pr-3">
                <Badge tone={a.side === "BUY" ? "pos" : a.side === "SELL" ? "neg" : "neutral"}>
                  {a.type}
                  {a.side ? ` ${a.side}` : ""}
                </Badge>
              </td>
              <td className="max-w-[220px] truncate py-2 pr-3">{a.title ?? "—"}</td>
              <td className="py-2 pr-3 text-muted">{a.outcome ?? "—"}</td>
              <td className="tabular py-2 pr-3 text-right">{a.price ? pct(a.price) : "—"}</td>
              <td className="tabular py-2 pr-3 text-right">{toNum(a.size).toFixed(2)}</td>
              <td className="tabular py-2 text-right">{usd(toNum(a.usdcSize))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryLoadMore({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="mt-3 flex justify-center">
      <Button variant="ghost" onClick={onLoadMore} disabled={loading} className="text-xs">
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
