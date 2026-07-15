"use client";

/**
 * Top holders per outcome (Data API /holders) — who is actually positioned in
 * this market. Slow-moving data; no polling.
 */
import { useMarketHolders } from "@/lib/queries";
import { shortAddress } from "@/lib/format";
import { Card, CardHeader } from "@/components/ui";

const shares = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toFixed(0);

export function HoldersCard({ marketId }: { marketId: string }) {
  const holders = useMarketHolders(marketId);
  const groups = holders.data?.groups ?? [];

  return (
    <Card>
      <CardHeader right={<span className="text-[11px] text-muted">by shares held</span>}>
        Top holders
      </CardHeader>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        {holders.isLoading ? (
          Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="skeleton h-32 rounded-lg" aria-hidden />
          ))
        ) : holders.isError ? (
          <p className="text-sm text-muted sm:col-span-2">Holder data unavailable right now.</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted sm:col-span-2">No holder data yet.</p>
        ) : (
          groups.map((g) => (
            <div key={g.tokenId}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                {g.outcome ?? "Outcome"}
              </div>
              <ol className="space-y-1">
                {g.holders.slice(0, 6).map((h, i) => (
                  <li
                    key={h.proxyWallet}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="tabular w-4 shrink-0 text-right text-[10px] text-faint">
                        {i + 1}
                      </span>
                      <span className="truncate text-fg">
                        {h.name ?? shortAddress(h.proxyWallet)}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-muted">{shares(h.amount)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
