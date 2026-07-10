import { ok, type Result } from "@mx2/core";
import type { GammaClient, PolymarketError } from "@mx2/polymarket-client";

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

export const searchMarketHits = async (
  gammaClient: GammaClient,
  q: string,
  limit: number,
): Promise<Result<MarketSearchHit[], PolymarketError>> => {
  const result = await gammaClient.searchMarkets(q, limit);
  if (!result.ok) return result;
  return ok(
    result.value.flatMap((event) => {
      const market = event.markets.find((m) => m.active && !m.closed) ?? event.markets[0];
      if (!market) return [];
      return [
        {
          eventId: event.id,
          marketId: market.id,
          title: event.markets.length > 1 ? market.question : event.title,
          eventTitle: event.title,
          image: market.image || event.image,
          conditionId: market.conditionId,
          tokenIds: parseJsonArray(market.clobTokenIds),
          outcomes: parseJsonArray(market.outcomes),
          outcomePrices: parseJsonArray(market.outcomePrices),
          volume: market.volume,
          liquidity: market.liquidity,
          endDate: market.endDate ?? event.endDate ?? null,
          negRisk: market.neg_risk ?? false,
          rewardsMinSize: market.rewardsMinSize ?? null,
          rewardsMaxSpread: market.rewardsMaxSpread ?? null,
        },
      ];
    }),
  );
};
