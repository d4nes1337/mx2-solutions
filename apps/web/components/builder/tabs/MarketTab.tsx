"use client";

/**
 * Market tab of the workspace panel: a live preview (price chart + order book
 * with depth) for whichever market the strategy references and the user
 * focused — clicking a market node on the canvas lands here.
 */
import { useState } from "react";
import { Segmented, Skeleton, cn } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { OrderbookTable } from "@/components/OrderbookTable";
import { useOrderbookByToken, useTokenPricesHistory } from "@/lib/queries";
import { cents } from "@/lib/format";
import { docMarketRefs, marketLabel } from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";

const RANGES: { value: string; label: string }[] = [
  { value: "6h", label: "6H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
];

function TokenPriceChart({ tokenId, outcome }: { tokenId: string; outcome: string }) {
  const [range, setRange] = useState("1d");
  const history = useTokenPricesHistory(tokenId, range);
  const series: ChartPoint[] = (history.data?.history ?? []).map((p) => ({ t: p.t, v: p.p }));
  const last = series[series.length - 1]?.v;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted">{outcome} price</span>
          <span className="tabular text-lg font-semibold leading-none text-fg">
            {last != null ? cents(last) : "—"}
          </span>
        </div>
        <Segmented options={RANGES} value={range} onChange={setRange} />
      </div>
      {history.isLoading ? (
        <Skeleton className="h-[160px] w-full" />
      ) : series.length >= 2 ? (
        <AreaChart data={series} height={160} baseline={0.5} valueFormat={(v) => cents(v)} />
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
          No price history yet for this range.
        </p>
      )}
    </div>
  );
}

export function MarketTab() {
  const doc = useBuilderStore((s) => s.doc);
  const focusedToken = useBuilderStore((s) => s.focusedMarketToken);
  const focusMarket = useBuilderStore((s) => s.focusMarket);
  const setAction = useBuilderStore((s) => s.setAction);

  const markets = docMarketRefs(doc);
  const active = markets.find((m) => m.tokenId === focusedToken) ?? markets[0];
  const book = useOrderbookByToken(active?.tokenId ?? null);

  // Clicking a book level prefills the order price when the strategy's order
  // trades this market; otherwise the book is read-only.
  const orderTradesThisMarket =
    doc.action.kind === "order" && doc.action.market.tokenId === active?.tokenId;
  const prefillPrice = orderTradesThisMarket
    ? (sel: { price: number }) => {
        if (doc.action.kind !== "order") return;
        setAction({ ...doc.action, price: sel.price });
      }
    : undefined;

  if (!active) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-[13px] text-muted">
        Bind a condition to a market (or add one from the canvas toolbar) to preview its chart and
        order book here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {markets.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {markets.map((m) => (
            <button
              key={m.tokenId}
              type="button"
              onClick={() => focusMarket(m.tokenId)}
              className={cn(
                "max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                m.tokenId === active.tokenId
                  ? "border-brand/50 bg-brand-soft text-accent"
                  : "border-border bg-surface text-muted hover:text-fg",
              )}
            >
              {marketLabel(doc, m)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-1">
        <h4 className="line-clamp-2 text-[13px] font-semibold leading-snug text-fg">
          {marketLabel(doc, active)}
        </h4>
        <span className="inline-flex rounded-full border border-brand/40 bg-brand-soft px-2 text-[10px] font-semibold text-accent">
          {active.outcome}
        </span>
      </div>

      <TokenPriceChart tokenId={active.tokenId} outcome={active.outcome} />

      <div className="space-y-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted">Order book</span>
        {book.isLoading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : book.data ? (
          <OrderbookTable bids={book.data.bids} asks={book.data.asks} onSelect={prefillPrice} />
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
            Order book unavailable right now.
          </p>
        )}
      </div>
    </div>
  );
}
