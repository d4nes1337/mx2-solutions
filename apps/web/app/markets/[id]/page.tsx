"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMarket, useOrderbook, usePricesHistory } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { parseJsonArray, pct, usd } from "@/lib/format";
import { Badge, Card, CardHeader, ErrorNote, Spinner, cn } from "@/components/ui";
import { Sparkline } from "@/components/Sparkline";
import { OrderbookTable } from "@/components/OrderbookTable";
import { OrderTicket } from "@/components/OrderTicket";
import { RuleBuilder } from "@/components/RuleBuilder";
import { RuleList } from "@/components/RuleList";
import { TriggerAlert } from "@/components/TriggerAlert";
import { StaleBanner } from "@/components/Banners";

export default function MarketCockpitPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const market = useMarket(id);
  const session = useSession();
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const orderbook = useOrderbook(id, outcomeIdx);
  const history = usePricesHistory(id);

  if (market.isLoading) return <Spinner label="Loading market…" />;
  if (market.error || !market.data)
    return (
      <ErrorNote message={market.error ? (market.error as Error).message : "Market not found"} />
    );

  const m = market.data;
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices);
  const tokenIds = parseJsonArray(m.clobTokenIds);
  const live = m._live;
  const isStale = live?.isStale ?? orderbook.data?.isStale ?? false;

  const ob = orderbook.data
    ? { bids: orderbook.data.bids, asks: orderbook.data.asks }
    : live?.orderbook;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{m.question}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Vol {usd(m.volume)}</span>
            <span>Liq {usd(m.liquidity)}</span>
            <span>Spread {pct(m.spread)}</span>
            {m.active && !m.closed ? (
              <Badge tone="pos">active</Badge>
            ) : (
              <Badge tone="neutral">closed</Badge>
            )}
          </div>
        </div>
      </div>

      {isStale ? <StaleBanner source={live?.orderbookSource} /> : null}

      <TriggerAlert />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: chart + orderbook */}
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>Price history (YES probability)</CardHeader>
            <div className="p-4">
              {history.isLoading ? (
                <Spinner />
              ) : history.data && history.data.history.length > 1 ? (
                <Sparkline values={history.data.history.map((p) => p.p)} />
              ) : (
                <div className="text-sm text-muted">No price history available.</div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <span>Orderbook</span>
                <div className="flex gap-1">
                  {(outcomes.length ? outcomes : ["YES", "NO"]).map((o, i) => (
                    <button
                      key={i}
                      onClick={() => setOutcomeIdx(i)}
                      disabled={!tokenIds[i]}
                      className={cn(
                        "rounded border px-2 py-0.5 text-xs disabled:opacity-30",
                        outcomeIdx === i
                          ? "border-accent/50 text-accent"
                          : "border-border text-muted",
                      )}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <div className="p-4">
              {orderbook.isLoading && !ob ? (
                <Spinner />
              ) : ob ? (
                <OrderbookTable bids={ob.bids} asks={ob.asks} />
              ) : (
                <div className="text-sm text-muted">Orderbook unavailable.</div>
              )}
              <div className="mt-3 flex justify-between text-xs text-muted">
                <span>
                  {outcomes[outcomeIdx] ?? `Outcome ${outcomeIdx}`} ·{" "}
                  {prices[outcomeIdx] ? pct(prices[outcomeIdx]) : "—"}
                </span>
                <span>source: {orderbook.data?.source ?? live?.orderbookSource ?? "—"}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right: order ticket + conditional rule builder */}
        <div className="space-y-4">
          <Card className="h-fit">
            <CardHeader>Order ticket</CardHeader>
            <div className="p-4">
              <OrderTicket
                conditionId={m.conditionId}
                tokenIds={tokenIds}
                outcomes={outcomes}
                negRisk={m.neg_risk ?? false}
                isStale={isStale}
                signedIn={Boolean(session.data)}
              />
            </div>
          </Card>

          <Card className="h-fit">
            <CardHeader>Conditional rule</CardHeader>
            <div className="p-4">
              <RuleBuilder
                marketId={id}
                conditionId={m.conditionId}
                tokenIds={tokenIds}
                outcomes={outcomes}
                signedIn={Boolean(session.data)}
              />
            </div>
          </Card>

          {session.data ? (
            <Card className="h-fit">
              <CardHeader>Rules on this market</CardHeader>
              <div className="p-4">
                <RuleList conditionId={m.conditionId} />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
