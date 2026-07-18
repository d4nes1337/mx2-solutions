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
  /** Sub-market label inside a multi-market event ("Over 2.5", a candidate). */
  groupItemTitle: string;
  bestBid: string;
  bestAsk: string;
  active: boolean;
  closed: boolean;
  /** Sports market type when Gamma tags it (moneyline/spreads/totals). */
  sportsMarketType: string | null;
}

/**
 * A search result at EVENT granularity: the event plus ALL its sub-markets
 * (totals/spreads inside a match, candidates inside an election), ordered for
 * display. The flat MarketSearchHit list is derived from these by collapsing
 * each event to its representative market — see hitsFromGroups.
 */
export interface EventSearchHit {
  eventId: string;
  title: string;
  image: string;
  endDate: string | null;
  negRisk: boolean;
  markets: MarketSearchHit[];
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
  groupItemTitle: market.groupItemTitle,
  bestBid: market.bestBid,
  bestAsk: market.bestAsk,
  active: market.active,
  closed: market.closed,
  sportsMarketType: market.sportsMarketType ?? null,
});

/** Display order for sports sub-markets: main line first, then derivatives. */
const SPORTS_TYPE_ORDER: Record<string, number> = {
  moneyline: 0,
  winner: 0,
  spreads: 1,
  spread: 1,
  totals: 2,
  total: 2,
};

/**
 * Sub-market sort: open markets first, sports by type (moneyline → spreads →
 * totals), neg-risk candidates by price (favorite first), else Gamma order.
 */
const subMarketSortKey = (hit: MarketSearchHit, negRisk: boolean, index: number): number => {
  const open = hit.active && !hit.closed ? 0 : 1;
  const sport = hit.sportsMarketType !== null ? (SPORTS_TYPE_ORDER[hit.sportsMarketType] ?? 3) : 3;
  const favorite = negRisk ? 1 - (Number(hit.outcomePrices[0]) || 0) : 0;
  // Composite: open (0/1) ≫ sports slot (0–3) ≫ favorite price ≫ stable index.
  return open * 1e9 + sport * 1e8 + favorite * 1e7 + index;
};

/** One Gamma event → an event-grouped hit with ordered sub-markets. */
export const eventHitFromGamma = (event: GammaEvent): EventSearchHit | null => {
  if (event.markets.length === 0) return null;
  const meta = {
    id: event.id,
    title: event.title,
    image: event.image,
    endDate: event.endDate ?? null,
    marketCount: event.markets.length,
  };
  const negRisk = event.negRisk ?? false;
  const markets = event.markets
    .map((m, i) => ({ hit: hitFromGammaMarket(m, meta), i }))
    .sort((a, b) => subMarketSortKey(a.hit, negRisk, a.i) - subMarketSortKey(b.hit, negRisk, b.i))
    .map(({ hit }) => hit);
  return {
    eventId: event.id,
    title: event.title,
    image: event.image,
    endDate: event.endDate ?? null,
    negRisk,
    markets,
  };
};

const groupsFromEvents = (events: readonly GammaEvent[]): EventSearchHit[] =>
  events.flatMap((event) => {
    const group = eventHitFromGamma(event);
    return group ? [group] : [];
  });

/**
 * Collapse event groups to one hit each — the ordered head sub-market (first
 * open, best-ranked). Preserves the pre-grouping flat contract for mentions,
 * the AI generator, and GET /api/markets/search.
 */
const hitsFromGroups = (groups: readonly EventSearchHit[]): MarketSearchHit[] => {
  const seen = new Set<string>();
  const hits: MarketSearchHit[] = [];
  for (const group of groups) {
    const head = group.markets[0];
    if (!head || seen.has(head.conditionId)) continue;
    seen.add(head.conditionId);
    hits.push(head);
  }
  return hits;
};

export const searchMarketHits = async (
  gammaClient: GammaClient,
  q: string,
  limit: number,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const result = await gammaClient.searchMarkets(q, limit);
  if (!result.ok) return result;
  return ok(hitsFromGroups(groupsFromEvents(result.value)));
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

// One cache serves both granularities: entries hold un-collapsed EVENT groups,
// and the flat hit list is derived per read — so the grouped endpoint adds
// ZERO extra Gamma traffic over the flat one.
const smartCache = new Map<string, { groups: EventSearchHit[]; fetchedAt: number }>();
const smartInflight = new Map<string, Promise<Result<EventSearchHit[], PolymarketError>>>();

/** Test hook. */
export const resetSmartSearchCache = (): void => {
  smartCache.clear();
  smartInflight.clear();
};

const fetchSmartGroups = async (
  gammaClient: GammaClient,
  uq: UnderstoodQuery,
  maxFanOut: number,
): Promise<Result<EventSearchHit[], PolymarketError>> => {
  const queries = uq.queries.slice(0, maxFanOut);
  const results = await Promise.all(
    queries.map((query) => gammaClient.searchMarkets(query, FAN_OUT_HITS_PER_QUERY)),
  );

  const seen = new Set<string>();
  const groups: EventSearchHit[] = [];
  let firstError: PolymarketError | null = null;
  const merge = (events: readonly GammaEvent[]) => {
    for (const group of groupsFromEvents(events)) {
      if (seen.has(group.eventId)) continue;
      seen.add(group.eventId);
      groups.push(group);
    }
  };
  for (const result of results) {
    if (!result.ok) {
      firstError ??= result.error;
      continue;
    }
    merge(result.value);
  }
  // All fan-out queries failed: surface the first error instead of an empty ok.
  if (firstError && results.every((r) => !r.ok)) return err(firstError);

  // Thin results: ONE widening retry without the active-events filter (catches
  // events Gamma no longer flags active but that still resolve later).
  if (groups.length < WIDEN_BELOW_HITS && uq.cleaned.length >= 2) {
    const widened = await gammaClient.searchMarkets(uq.cleaned, FAN_OUT_HITS_PER_QUERY, {
      status: "any",
    });
    if (widened.ok) merge(widened.value);
  }

  return ok(groups);
};

export interface SmartSearchOptions {
  limit: number;
  /** Parallel Gamma queries per cache refresh (default and hard cap 3). */
  maxFanOut?: number;
}

/** Shared fetch/cache core for both search granularities. */
const smartSearchGroupsCached = async (
  gammaClient: GammaClient,
  q: string,
  maxFanOutRaw: number | undefined,
): Promise<Result<{ groups: EventSearchHit[]; uq: UnderstoodQuery }, PolymarketError>> => {
  const maxFanOut = Math.min(Math.max(maxFanOutRaw ?? MAX_FAN_OUT, 1), MAX_FAN_OUT);
  const uq = understandQuery(q, Date.now());
  const key = `${maxFanOut}:${uq.cleaned}`;

  const cached = smartCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SMART_TTL_MS) {
    // Re-insert to refresh recency (Map order drives the LRU-ish eviction).
    smartCache.delete(key);
    smartCache.set(key, cached);
    return ok({ groups: cached.groups, uq });
  }

  let inflight = smartInflight.get(key);
  if (!inflight) {
    inflight = fetchSmartGroups(gammaClient, uq, maxFanOut)
      .then((result) => {
        if (result.ok) {
          smartCache.delete(key);
          smartCache.set(key, { groups: result.value, fetchedAt: Date.now() });
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
  return ok({ groups: result.value, uq });
};

/**
 * Query-understood fan-out search: parse the raw query (dates, synonyms), fan
 * out parallel Gamma searches, collapse + dedup, widen once when thin, then
 * re-rank locally. Group lists are cached UNRANKED per normalized query so two
 * queries differing only in date tokens still rank against their own window.
 */
export const smartSearchMarketHits = async (
  gammaClient: GammaClient,
  q: string,
  opts: SmartSearchOptions,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const result = await smartSearchGroupsCached(gammaClient, q, opts.maxFanOut);
  if (!result.ok) return result;
  const { groups, uq } = result.value;
  return ok(rankHits(hitsFromGroups(groups), uq).slice(0, opts.limit));
};

export interface SmartEventSearchOptions extends SmartSearchOptions {
  /** Cap on sub-markets returned per event (payload guard). */
  marketsPerEvent?: number;
}

/**
 * Event-granularity variant of the smart search: same cache, same rate
 * budget, but each result keeps ALL its sub-markets (ordered for display).
 * Events are ranked by their representative market's relevance.
 */
export const smartSearchEventHits = async (
  gammaClient: GammaClient,
  q: string,
  opts: SmartEventSearchOptions,
): Promise<Result<EventSearchHit[], PolymarketError>> => {
  const result = await smartSearchGroupsCached(gammaClient, q, opts.maxFanOut);
  if (!result.ok) return result;
  const { groups, uq } = result.value;
  const byEventId = new Map(groups.map((g) => [g.eventId, g]));
  const ranked = rankHits(hitsFromGroups(groups), uq);
  const marketsPerEvent = Math.max(opts.marketsPerEvent ?? 20, 1);
  const out: EventSearchHit[] = [];
  for (const rep of ranked) {
    if (out.length >= opts.limit) break;
    const group = byEventId.get(rep.eventId);
    if (!group) continue;
    out.push(
      group.markets.length > marketsPerEvent
        ? { ...group, markets: group.markets.slice(0, marketsPerEvent) }
        : group,
    );
  }
  return ok(out);
};
