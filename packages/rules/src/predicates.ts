/**
 * Pure book-derived metrics. The public Polymarket book is aggregated by price
 * level (docs/04 §3.2), so we can only reason about per-level aggregates, not
 * individual underlying orders. Notional is computed in USD as Σ(price × size)
 * over the levels in band, rounded to 6 decimals (USDC precision). The rounding
 * convention is deliberate and pinned by tests so triggers are reproducible.
 */
import type { BookLevel, BookSide, MarketDataView } from "./types.js";

/**
 * Price movement over the trailing window [nowMs − windowMs, nowMs], from the
 * host-attached rolling price history. Returns null unless the window is FULLY
 * covered: at least one sample at/before the window start (so the extremes are
 * meaningful) and one inside it. Extremes are taken over samples in the window
 * plus the last sample at/before its start (the price "carried into" the
 * window). drop = max − last, rise = last − min; both ≥ 0.
 */
export const priceMove = (
  v: MarketDataView,
  windowMs: number,
  nowMs: number,
): { drop: number; rise: number; last: number } | null => {
  const hist = v.priceHistory;
  if (!hist || hist.length === 0) return null;
  const startMs = nowMs - windowMs;

  // Oldest-first scan: track the carry-in sample and window extremes.
  let carryIn: number | null = null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let last: number | null = null;
  let samplesInWindow = 0;
  for (const s of hist) {
    if (s.t > nowMs) break; // ignore future samples (clock skew safety)
    if (s.t <= startMs) {
      carryIn = s.p;
      continue;
    }
    samplesInWindow++;
    if (s.p < min) min = s.p;
    if (s.p > max) max = s.p;
    last = s.p;
  }
  if (carryIn === null || samplesInWindow === 0 || last === null) return null;
  min = Math.min(min, carryIn);
  max = Math.max(max, carryIn);
  return { drop: round6(max - last), rise: round6(last - min), last };
};

/** Round to USDC precision (6 dp), avoiding binary-float drift. */
export const round6 = (n: number): number => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

export const bestAsk = (v: MarketDataView): number | null => v.asks[0]?.price ?? null;
export const bestBid = (v: MarketDataView): number | null => v.bids[0]?.price ?? null;

export const spread = (v: MarketDataView): number | null => {
  const a = bestAsk(v);
  const b = bestBid(v);
  if (a === null || b === null) return null;
  return round6(a - b);
};

/** Levels within the band on the given side. ask: price ≤ bound; bid: price ≥ bound. */
const levelsInBand = (
  v: MarketDataView,
  side: BookSide,
  priceBound: number,
): readonly BookLevel[] => {
  const levels = side === "ask" ? v.asks : v.bids;
  return levels.filter((l) => (side === "ask" ? l.price <= priceBound : l.price >= priceBound));
};

export const cumulativeNotional = (v: MarketDataView, side: BookSide, priceBound: number): number =>
  round6(levelsInBand(v, side, priceBound).reduce((sum, l) => sum + l.price * l.size, 0));

export const cumulativeShares = (v: MarketDataView, side: BookSide, priceBound: number): number =>
  round6(levelsInBand(v, side, priceBound).reduce((sum, l) => sum + l.size, 0));

/** Count of non-empty (size > 0) visible levels within the band. */
export const visibleLevels = (v: MarketDataView, side: BookSide, priceBound: number): number =>
  levelsInBand(v, side, priceBound).filter((l) => l.size > 0).length;

/**
 * Data age in the processing clock. Clamped at 0 to avoid negative ages from
 * minor clock skew; large-skew handling is a deferred failure mode (docs/04 §7).
 */
export const dataAgeMs = (v: MarketDataView, nowMs: number): number =>
  Math.max(0, nowMs - v.sourceTimeMs);
