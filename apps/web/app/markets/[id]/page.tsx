"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMarket, useOrderbook } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { parseJsonArray, pct, usdCompact } from "@/lib/format";
import { Badge, Card, CardHeader, ErrorNote, Segmented, Spinner } from "@/components/ui";
import { MarketPriceChart } from "@/components/charts/MarketPriceChart";
import { OrderbookTable } from "@/components/OrderbookTable";
import { OrderTicket } from "@/components/OrderTicket";
import { RuleBuilder } from "@/components/RuleBuilder";
import { RuleList } from "@/components/RuleList";
import { TriggerAlert } from "@/components/TriggerAlert";
import { StaleBanner } from "@/components/Banners";

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="tabular text-sm font-semibold text-fg">{value}</span>
    </div>
  );
}

export default function MarketCockpitPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const market = useMarket(id);
  const session = useSession();
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const orderbook = useOrderbook(id, outcomeIdx);

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

  const outcomeOptions = (outcomes.length ? outcomes : ["YES", "NO"]).map((o, i) => ({
    value: String(i),
    label: o,
    disabled: !tokenIds[i],
  }));
  const outcomeLabel = outcomes[outcomeIdx] ?? `Outcome ${outcomeIdx}`;

  const ob = orderbook.data
    ? { bids: orderbook.data.bids, asks: orderbook.data.asks }
    : live?.orderbook;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/" className="text-xs text-muted transition-colors hover:text-accent">
          ← Markets
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-snug text-fg sm:text-xl">{m.question}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {m.active && !m.closed ? (
                <Badge tone="pos" dot>
                  active
                </Badge>
              ) : (
                <Badge tone="neutral">closed</Badge>
              )}
              {m.neg_risk ? <Badge tone="accent">neg-risk</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <HeaderStat label="Volume" value={usdCompact(m.volume)} />
            <HeaderStat label="Liquidity" value={usdCompact(m.liquidity)} />
            <HeaderStat label="Spread" value={pct(m.spread)} />
          </div>
        </div>
      </div>

      {isStale ? <StaleBanner source={live?.orderbookSource} /> : null}

      <TriggerAlert />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: chart + orderbook */}
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-end">
            <Segmented
              options={outcomeOptions}
              value={String(outcomeIdx)}
              onChange={(v) => setOutcomeIdx(Number(v))}
              size="md"
            />
          </div>

          <MarketPriceChart marketId={id} outcome={outcomeIdx} outcomeLabel={outcomeLabel} />

          <Card>
            <CardHeader
              right={
                <span className="tabular text-xs text-muted">
                  {outcomeLabel} · {prices[outcomeIdx] ? pct(prices[outcomeIdx]) : "—"}
                </span>
              }
            >
              Order book
            </CardHeader>
            <div className="p-4">
              {orderbook.isLoading && !ob ? (
                <Spinner />
              ) : ob ? (
                <OrderbookTable bids={ob.bids} asks={ob.asks} />
              ) : (
                <div className="text-sm text-muted">Order book unavailable.</div>
              )}
              <div className="mt-3 flex justify-end text-[11px] text-faint">
                source: {orderbook.data?.source ?? live?.orderbookSource ?? "—"}
              </div>
            </div>
          </Card>
        </div>

        {/* Right: order ticket + conditional rule builder */}
        <div className="space-y-4">
          <Card glow className="h-fit">
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
