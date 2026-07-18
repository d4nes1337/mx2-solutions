import { ok, type Result } from "@mx2/core";
import type { GammaClient, PolymarketError } from "@mx2/polymarket-client";
import { eventHitFromGamma, type EventSearchHit } from "./market-search.js";

/**
 * Event-grouped sibling lookups for the event page, the market-detail "More
 * from this event" panel, and the builder's "Also in this event" section.
 * Both lookups resolve to the same grouped DTO the search endpoints emit.
 *
 * Budget: ≤1 getEvent (+1 findMarket for token lookups) per cache miss, with
 * 30s TTL caches keyed by event id / token id.
 */

const TTL_MS = 30_000;
const MAX_ENTRIES = 300;

const eventCache = new Map<string, { value: EventSearchHit | null; fetchedAt: number }>();
const tokenEventCache = new Map<string, { eventId: string | null; fetchedAt: number }>();

/** Test hook. */
export const resetEventSiblingsCache = (): void => {
  eventCache.clear();
  tokenEventCache.clear();
};

const trim = (map: Map<string, unknown>): void => {
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

export const groupedEvent = async (
  gammaClient: GammaClient,
  eventId: string,
): Promise<Result<EventSearchHit | null, PolymarketError>> => {
  const cached = eventCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return ok(cached.value);
  const result = await gammaClient.getEvent(eventId);
  if (!result.ok) return result;
  const value = eventHitFromGamma(result.value);
  eventCache.set(eventId, { value, fetchedAt: Date.now() });
  trim(eventCache);
  return ok(value);
};

export const groupedEventByToken = async (
  gammaClient: GammaClient,
  tokenId: string,
): Promise<Result<EventSearchHit | null, PolymarketError>> => {
  const cached = tokenEventCache.get(tokenId);
  if (!cached || Date.now() - cached.fetchedAt >= TTL_MS) {
    const market = await gammaClient.findMarket({ tokenId });
    if (!market.ok) return market;
    const eventId = market.value?.events?.[0]?.id ?? null;
    tokenEventCache.set(tokenId, { eventId, fetchedAt: Date.now() });
    trim(tokenEventCache);
  }
  const eventId = tokenEventCache.get(tokenId)?.eventId ?? null;
  if (!eventId) return ok(null);
  return groupedEvent(gammaClient, eventId);
};
