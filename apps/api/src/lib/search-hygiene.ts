import type { EventSearchHit, MarketSearchHit } from "./market-search.js";

/**
 * Search hygiene for recurring ("instant") markets — ADR-0015 amendment.
 *
 * Recurring series (BTC Up or Down 5m/15m, weekly strikes…) flood search
 * results with dead instances: windows that already ended, or that are priced
 * 0/100 with nothing left to trade. This module cleans a fetched candidate
 * set at READ time (the smart-search cache stays a raw superset, so
 * Date.now()-dependent decisions stay correct within the cache TTL):
 *
 *  - ended SERIES instances are dropped outright (their successor exists);
 *  - ended one-off events are only DEMOTED (ADR-0015's widening retry
 *    deliberately admits them for "what happened?" queries);
 *  - each series is collapsed to its single most tradable instance — the one
 *    ending soonest in the future, skipping ahead once if that window is
 *    already decided (≤1¢ / ≥99¢) and a later instance exists;
 *  - the losing siblings are demoted, not deleted, so "next window" stays one
 *    scroll away.
 */

/** Head price is effectively settled: nothing left to trade at ≤1¢ / ≥99¢. */
export const isDecided = (hit: MarketSearchHit): boolean => {
  const p = Number(hit.outcomePrices[0]);
  return Number.isFinite(p) && (p <= 0.01 || p >= 0.99);
};

/** endDate strictly in the past (missing/unparseable dates are NOT ended). */
export const isEnded = (endDate: string | null, nowMs: number): boolean => {
  if (!endDate) return false;
  const endMs = Date.parse(endDate);
  return Number.isFinite(endMs) && endMs < nowMs;
};

const endMsOf = (group: EventSearchHit): number => {
  const endMs = group.endDate ? Date.parse(group.endDate) : NaN;
  return Number.isFinite(endMs) ? endMs : Number.MAX_SAFE_INTEGER;
};

export interface SeriesHygieneResult {
  /** Clean candidates, ranked first. */
  primary: EventSearchHit[];
  /** Kept-but-deprioritized: ended one-offs, non-chosen series siblings. */
  demoted: EventSearchHit[];
}

export const applySeriesHygiene = (
  groups: readonly EventSearchHit[],
  nowMs: number,
): SeriesHygieneResult => {
  const primary: EventSearchHit[] = [];
  const demoted: EventSearchHit[] = [];
  const bySeries = new Map<string, EventSearchHit[]>();

  for (const group of groups) {
    if (group.seriesSlug) {
      if (isEnded(group.endDate, nowMs)) continue; // dead instance — drop
      const bucket = bySeries.get(group.seriesSlug);
      if (bucket) bucket.push(group);
      else bySeries.set(group.seriesSlug, [group]);
    } else if (isEnded(group.endDate, nowMs)) {
      demoted.push(group);
    } else {
      primary.push(group);
    }
  }

  for (const instances of bySeries.values()) {
    instances.sort((a, b) => endMsOf(a) - endMsOf(b));
    let chosen = instances[0]!;
    // The soonest-ending window can already be settled (e.g. this week's
    // "MicroStrategy purchase?" at 0¢ the night before rollover) — prefer the
    // next live instance when one is in the candidate set.
    if (instances.length > 1) {
      const head = chosen.markets[0];
      if (head && isDecided(head)) chosen = instances[1]!;
    }
    primary.push(chosen);
    for (const inst of instances) if (inst !== chosen) demoted.push(inst);
  }

  return { primary, demoted };
};
