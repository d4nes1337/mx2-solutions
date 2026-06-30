import type { GammaEvent, GammaMarket } from "./types";
import { parseJsonArray, toNum } from "./format";

export const FEED_LIMIT = 20;

export type FeedKind = "latest" | "volumeWeek" | "hottest" | "favoritesDefault";

/** Pick the most liquid open market in an event for feed display. */
export function primaryMarket(event: GammaEvent): GammaMarket | undefined {
  const selectedId = selectedFeedMarketId(event);
  if (selectedId) {
    const selected = event.markets.find((m) => m.id === selectedId && !m.closed);
    if (selected) return selected;
  }
  return [...event.markets]
    .filter((m) => !m.closed)
    .sort((a, b) => toNum(b.liquidity) - toNum(a.liquidity))[0];
}

function selectedFeedMarketId(event: GammaEvent): string | null {
  const meta = event["_feed"] as { selectedMarketId?: unknown } | undefined;
  return typeof meta?.selectedMarketId === "string" ? meta.selectedMarketId : null;
}

export function eventVolume1wk(event: GammaEvent): number {
  const raw = event.volume1wk ?? event.volume;
  return toNum(raw);
}

export function marketEndMs(market: GammaMarket, event: GammaEvent): number {
  const raw = market.endDate ?? event.endDate;
  if (!raw) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function eventCreatedMs(event: GammaEvent): number {
  const raw = event.createdAt ?? event.creationDate;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/** Higher = resolves sooner (within ~90d window). */
export function resolveUrgency(endMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(endMs)) return 0;
  const days = Math.max(0, (endMs - nowMs) / 86_400_000);
  if (days > 90) return 0;
  return (90 - days) / 90;
}

/** Hottest: high recent volume + resolving soon. */
export function hottestScore(event: GammaEvent, nowMs = Date.now()): number {
  const market = primaryMarket(event);
  if (!market) return 0;
  const vol = eventVolume1wk(event);
  const urgency = resolveUrgency(marketEndMs(market, event), nowMs);
  return vol * (0.35 + 0.65 * urgency);
}

/** Default favorites placeholder: recent listings with traction. */
export function newVolumeScore(event: GammaEvent, nowMs = Date.now()): number {
  const market = primaryMarket(event);
  if (!market) return 0;
  const vol = eventVolume1wk(event);
  const ageDays = Math.max(1, (nowMs - eventCreatedMs(event)) / 86_400_000);
  const newness = 1 / ageDays;
  return vol * newness;
}

export function sortEventsByScore(
  events: GammaEvent[],
  scoreFn: (e: GammaEvent) => number,
): GammaEvent[] {
  return [...events]
    .filter((e) => primaryMarket(e) !== undefined)
    .sort((a, b) => scoreFn(b) - scoreFn(a))
    .slice(0, FEED_LIMIT);
}

export function yesTopOfBook(market: GammaMarket): { bid: number; ask: number } {
  const bid = toNum(market.bestBid);
  const ask = toNum(market.bestAsk);
  if (bid > 0 && ask > 0) return { bid, ask };
  return { bid, ask: ask > 0 ? ask : bid };
}

/** Best estimate of YES probability (0–1): book mid, else last trade, else price array. */
export function yesProbability(market: GammaMarket): number {
  const { bid, ask } = yesTopOfBook(market);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = toNum(market.lastTradePrice);
  if (last > 0) return last;
  const prices = parseJsonArray(market.outcomePrices);
  return toNum(prices[0]);
}

export function noTopOfBook(market: GammaMarket): { bid: number; ask: number } {
  const yes = yesTopOfBook(market);
  if (yes.bid <= 0 && yes.ask <= 0) return { bid: 0, ask: 0 };
  return { bid: Math.max(0, 1 - yes.ask), ask: Math.max(0, 1 - yes.bid) };
}

export function formatResolveIn(endMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(endMs)) return "—";
  const days = Math.ceil((endMs - nowMs) / 86_400_000);
  if (days < 0) return "past due";
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}
