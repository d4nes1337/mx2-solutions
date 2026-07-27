import type { MarketRef } from "@mx2/rules";
import type { MarketMeta } from "./doc";
import type { MarketSearchResult } from "./queries";

/**
 * One place that turns a search/instant-market result + outcome index into
 * the builder's bind payload, so every picker (search rows, instant rail,
 * pinned series card) binds identically — including the recurring-series
 * fields that drive the expiry default and window countdowns.
 */
export const refFromResult = (r: MarketSearchResult, outcomeIdx: number): MarketRef | null => {
  const tokenId = r.tokenIds[outcomeIdx];
  if (!tokenId) return null;
  return {
    conditionId: r.conditionId,
    tokenId,
    outcome: r.outcomes[outcomeIdx] ?? "YES",
    title: r.title,
  };
};

export const metaFromResult = (
  r: MarketSearchResult,
  outcomeIdx: number,
  over?: Partial<MarketMeta>,
): MarketMeta => ({
  title: r.title,
  eventTitle: r.eventTitle,
  image: r.image,
  rewardsMinSize: r.rewardsMinSize,
  rewardsMaxSpread: r.rewardsMaxSpread,
  currentPrice: r.outcomePrices[outcomeIdx] ? Number(r.outcomePrices[outcomeIdx]) : null,
  endDate: r.endDate ?? null,
  seriesSlug: r.seriesSlug ?? null,
  recurrence: r.recurrence ?? null,
  ...over,
});
