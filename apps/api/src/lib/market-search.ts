import { ok, err, type Result } from "@mx2/core";
import type { GammaClient, GammaEvent, GammaMarket, PolymarketError } from "@mx2/polymarket-client";
import { rankHits, understandQuery, type UnderstoodQuery } from "./query-understanding.js";

/**
 * One search candidate in the shape the builder (and the AI generator) needs:
 * a market pinned to its event with token ids, outcome labels + prices and
 * the maker-rewards params. Shared by GET /api/markets/search and the AI
 * strategy generator so both resolve markets identically.
 */
export interface MarketSearchHit {
  eventId: string;
  marketId: string;
  title: string;
  eventTitle: string;
  image: string;
  conditionId: string;
  tokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  /** Gamma returns these as numeric strings. */
  volume: string;
  liquidity: string;
  endDate: string | null;
  negRisk: boolean;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
}

const parseJsonArray = (raw: string): string[] => {
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Map one Gamma market (optionally with its event for a better title/image)
 * into the shared candidate shape. Reused by search, the AI generator's
 * pinned markets, and the showcase engine.
 */
export const hitFromGammaMarket = (
  market: GammaMarket,
  event?: {
    id: string;
    title: string;
    image: string;
    endDate?: string | null;
    marketCount?: number;
  },
): MarketSearchHit => ({
  eventId: event?.id ?? "",
  marketId: market.id,
  title: event && (event.marketCount ?? 1) <= 1 ? event.title : market.question,
  eventTitle: event?.title ?? market.question,
  image: market.image || (event?.image ?? ""),
  conditionId: market.conditionId,
  tokenIds: parseJsonArray(market.clobTokenIds),
  outcomes: parseJsonArray(market.outcomes),
  outcomePrices: parseJsonArray(market.outcomePrices),
  volume: market.volume,
  liquidity: market.liquidity,
  endDate: market.endDate ?? event?.endDate ?? null,
  negRisk: market.neg_risk ?? false,
  rewardsMinSize: market.rewardsMinSize ?? null,
  rewardsMaxSpread: market.rewardsMaxSpread ?? null,
});

/** Collapse Gamma events to one hit each: the first active market (or first). */
const hitsFromEvents = (events: readonly GammaEvent[]): MarketSearchHit[] =>
  events.flatMap((event) => {
    const market = event.markets.find((m) => m.active && !m.closed) ?? event.markets[0];
    if (!market) return [];
    return [
      hitFromGammaMarket(market, {
        id: event.id,
        title: event.title,
        image: event.image,
        endDate: event.endDate ?? null,
        marketCount: event.markets.length,
      }),
    ];
  });

export const searchMarketHits = async (
  gammaClient: GammaClient,
  q: string,
  limit: number,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const result = await gammaClient.searchMarkets(q, limit);
  if (!result.ok) return result;
  return ok(hitsFromEvents(result.value));
};

// ── Smart pass-through search (query understanding + fan-out + re-rank) ──────
//
// Rate budget: ≤ maxFanOut (≤3) parallel Gamma queries per cache refresh plus
// at most ONE widening retry; the 30s TTL cache with a single-inflight guard
// bounds amplification from typing/debounce bursts (single process per D-001).

const SMART_TTL_MS = 30_000;
const SMART_MAX_ENTRIES = 200;
const FAN_OUT_HITS_PER_QUERY = 20;
const WIDEN_BELOW_HITS = 3;
const MAX_FAN_OUT = 3;

const smartCache = new Map<string, { hits: MarketSearchHit[]; fetchedAt: number }>();
const smartInflight = new Map<string, Promise<Result<MarketSearchHit[], PolymarketError>>>();

/** Test hook. */
export const resetSmartSearchCache = (): void => {
  smartCache.clear();
  smartInflight.clear();
};

const fetchSmartHits = async (
  gammaClient: GammaClient,
  uq: UnderstoodQuery,
  maxFanOut: number,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const queries = uq.queries.slice(0, maxFanOut);
  const results = await Promise.all(
    queries.map((query) => gammaClient.searchMarkets(query, FAN_OUT_HITS_PER_QUERY)),
  );

  const seen = new Set<string>();
  const hits: MarketSearchHit[] = [];
  let firstError: PolymarketError | null = null;
  for (const result of results) {
    if (!result.ok) {
      firstError ??= result.error;
      continue;
    }
    for (const hit of hitsFromEvents(result.value)) {
      if (seen.has(hit.conditionId)) continue;
      seen.add(hit.conditionId);
      hits.push(hit);
    }
  }
  // All fan-out queries failed: surface the first error instead of an empty ok.
  if (firstError && results.every((r) => !r.ok)) return err(firstError);

  // Thin results: ONE widening retry without the active-events filter (catches
  // events Gamma no longer flags active but that still resolve later).
  if (hits.length < WIDEN_BELOW_HITS && uq.cleaned.length >= 2) {
    const widened = await gammaClient.searchMarkets(uq.cleaned, FAN_OUT_HITS_PER_QUERY, {
      status: "any",
    });
    if (widened.ok) {
      for (const hit of hitsFromEvents(widened.value)) {
        if (seen.has(hit.conditionId)) continue;
        seen.add(hit.conditionId);
        hits.push(hit);
      }
    }
  }

  return ok(hits);
};

export interface SmartSearchOptions {
  limit: number;
  /** Parallel Gamma queries per cache refresh (default and hard cap 3). */
  maxFanOut?: number;
}

/**
 * Query-understood fan-out search: parse the raw query (dates, synonyms), fan
 * out parallel Gamma searches, collapse + dedup, widen once when thin, then
 * re-rank locally. Hit lists are cached UNRANKED per normalized query so two
 * queries differing only in date tokens still rank against their own window.
 */
export const smartSearchMarketHits = async (
  gammaClient: GammaClient,
  q: string,
  opts: SmartSearchOptions,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const maxFanOut = Math.min(Math.max(opts.maxFanOut ?? MAX_FAN_OUT, 1), MAX_FAN_OUT);
  const uq = understandQuery(q, Date.now());
  const key = `${maxFanOut}:${uq.cleaned}`;

  const cached = smartCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SMART_TTL_MS) {
    // Re-insert to refresh recency (Map order drives the LRU-ish eviction).
    smartCache.delete(key);
    smartCache.set(key, cached);
    return ok(rankHits(cached.hits, uq).slice(0, opts.limit));
  }

  let inflight = smartInflight.get(key);
  if (!inflight) {
    inflight = fetchSmartHits(gammaClient, uq, maxFanOut)
      .then((result) => {
        if (result.ok) {
          smartCache.delete(key);
          smartCache.set(key, { hits: result.value, fetchedAt: Date.now() });
          while (smartCache.size > SMART_MAX_ENTRIES) {
            const oldest = smartCache.keys().next().value;
            if (oldest === undefined) break;
            smartCache.delete(oldest);
          }
        }
        return result;
      })
      .finally(() => {
        smartInflight.delete(key);
      });
    smartInflight.set(key, inflight);
  }

  const result = await inflight;
  if (!result.ok) return result;
  return ok(rankHits(result.value, uq).slice(0, opts.limit));
};
