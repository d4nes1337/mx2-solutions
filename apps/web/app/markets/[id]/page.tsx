"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMarket, useOrderbook } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { cents, parseJsonArray, pct, toNum, usdCompact } from "@/lib/format";
import { yesProbability } from "@/lib/feeds";
import type { OrderSide } from "@/lib/types";
import { Badge, Card, CardHeader, ErrorNote, Segmented, Spinner, cn } from "@/components/ui";
import { AnimatedNumber, FlashOnChange } from "@/components/motion";
import { MarketPriceChart } from "@/components/charts/MarketPriceChart";
import { OrderbookTable, type BookSelection } from "@/components/OrderbookTable";
import { MarketMovesTape } from "@/components/trade/MarketMovesTape";
import { QueueCard } from "@/components/trade/QueuePosition";
import { OrderTicket } from "@/components/OrderTicket";
import { RuleBuilder } from "@/components/RuleBuilder";
import { RuleList } from "@/components/RuleList";
import { TriggerAlert } from "@/components/TriggerAlert";
import { StaleBanner } from "@/components/Banners";
import { AutomateCard } from "@/components/market/AutomateCard";
import { EventSiblingsPanel } from "@/components/market/EventSiblingsPanel";
import { BacktestTeaser } from "@/components/market/BacktestTeaser";
import { MarketScenarios } from "@/components/market/MarketScenarios";
import { RecentTradesCard } from "@/components/market/RecentTradesCard";
import { HoldersCard } from "@/components/market/HoldersCard";

type Prefill = { price?: string; size?: string; side?: OrderSide; nonce: number };

export default function MarketCockpitPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const market = useMarket(id);
  const session = useSession();
  const signedIn = Boolean(session.data);
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [view, setView] = useState<"overview" | "advanced">("overview");
  const [prefill, setPrefill] = useState<Prefill | undefined>(undefined);
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
  const outcomeProb = prices[outcomeIdx] != null ? toNum(prices[outcomeIdx]) : yesProbability(m);

  const ob = orderbook.data
    ? { bids: orderbook.data.bids, asks: orderbook.data.asks }
    : live?.orderbook;

  // Live mid for the payoff estimate in the ticket (falls back to the
  // outcome's implied probability when the book is thin).
  const bestBid = toNum(ob?.bids?.[0]?.price);
  const bestAsk = toNum(ob?.asks?.[0]?.price);
  const currentPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : outcomeProb;

  // Click a book level → prefill the ticket. Lifting an ask means you BUY into it;
  // a bid means you SELL into it. Suggested size = that level's depth.
  const onBookSelect = (sel: BookSelection) => {
    setPrefill({
      price: String(Number(sel.price.toFixed(3))),
      size: String(Math.max(1, Math.round(sel.size))),
      side: sel.side === "ask" ? "BUY" : "SELL",
      nonce: Date.now(),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <Link href="/markets" className="text-xs text-muted transition-colors hover:text-accent">
          ← Markets
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
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
              <span className="tabular text-[11px] text-muted">
                Vol {usdCompact(m.volume)} · Liq {usdCompact(m.liquidity)} · Spr {pct(m.spread)}
              </span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[10px] uppercase tracking-wide text-muted">{outcomeLabel}</div>
            <FlashOnChange value={outcomeProb}>
              <div
                className={cn(
                  "tabular text-3xl font-semibold leading-none",
                  outcomeProb >= 0.5 ? "text-fg" : "text-neg",
                )}
              >
                <AnimatedNumber value={outcomeProb * 100} format={(n) => `${n.toFixed(0)}%`} />
              </div>
            </FlashOnChange>
            <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px]">
              <span className="tabular rounded-sm bg-pos/10 px-1 py-px font-medium text-pos">
                Y {cents(outcomeProb)}
              </span>
              <span className="tabular rounded-sm bg-neg/10 px-1 py-px font-medium text-neg">
                N {cents(1 - outcomeProb)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {isStale ? <StaleBanner source={live?.orderbookSource} /> : null}

      <TriggerAlert />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: chart (overview) or book/tape/queue (advanced) */}
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <Segmented
              options={[
                { value: "overview", label: "Overview" },
                { value: "advanced", label: "Advanced" },
              ]}
              value={view}
              onChange={(v) => setView(v)}
              size="md"
            />
            <Segmented
              options={outcomeOptions}
              value={String(outcomeIdx)}
              onChange={(v) => setOutcomeIdx(Number(v))}
              size="md"
            />
          </div>

          <MarketPriceChart marketId={id} outcome={outcomeIdx} outcomeLabel={outcomeLabel} />

          {/* Entry scenarios live directly under the chart — the "how could I
              play this?" answer a fresh user is actually looking for. */}
          <MarketScenarios marketId={id} outcomeIdx={outcomeIdx} outcomeLabel={outcomeLabel} />

          <Card>
            <CardHeader
              right={<span className="text-[11px] text-muted">click a level to trade</span>}
            >
              Order book
            </CardHeader>
            <div className="p-4">
              {orderbook.isLoading && !ob ? (
                <Spinner />
              ) : ob ? (
                <OrderbookTable bids={ob.bids} asks={ob.asks} onSelect={onBookSelect} />
              ) : (
                <div className="text-sm text-muted">Order book unavailable.</div>
              )}
              <div className="mt-3 flex justify-end text-[11px] text-faint">
                source: {orderbook.data?.source ?? live?.orderbookSource ?? "—"}
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <RecentTradesCard marketId={id} />
            <HoldersCard marketId={id} />
          </div>

          {view === "advanced" ? (
            <>
              {ob ? <MarketMovesTape bids={ob.bids} asks={ob.asks} /> : null}

              <QueueCard
                signedIn={signedIn}
                tokenId={tokenIds[outcomeIdx]}
                bids={ob?.bids ?? []}
                asks={ob?.asks ?? []}
              />
            </>
          ) : null}
        </div>

        {/* Right: trade + Smart Order entry (advanced keeps the raw rule form) */}
        <div className="space-y-4">
          <Card glow className="h-fit">
            <CardHeader>Trade</CardHeader>
            <div className="p-4">
              <OrderTicket
                conditionId={m.conditionId}
                tokenIds={tokenIds}
                outcomes={outcomes}
                negRisk={m.neg_risk ?? false}
                isStale={isStale}
                signedIn={signedIn}
                outcomeIdx={outcomeIdx}
                prefill={prefill}
                currentPrice={currentPrice}
              />
            </div>
          </Card>

          <AutomateCard
            conditionId={m.conditionId}
            tokenId={tokenIds[outcomeIdx]}
            outcome={outcomes[outcomeIdx] ?? "YES"}
            title={m.question}
          />

          <BacktestTeaser
            conditionId={m.conditionId}
            tokenId={tokenIds[outcomeIdx] ?? null}
            outcome={outcomes[outcomeIdx] ?? "YES"}
            title={m.question}
          />

          <EventSiblingsPanel tokenId={tokenIds[0] ?? null} currentMarketId={id} />

          {view === "advanced" ? (
            <>
              <Card className="h-fit">
                <CardHeader>Quick rule (classic form)</CardHeader>
                <div className="p-4">
                  <RuleBuilder
                    marketId={id}
                    conditionId={m.conditionId}
                    tokenIds={tokenIds}
                    outcomes={outcomes}
                    signedIn={signedIn}
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
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
