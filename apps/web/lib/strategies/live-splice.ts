import type { ChartPoint } from "@/components/charts/AreaChart";

/**
 * Splice the live order-book quote onto a candle series so the chart's right
 * edge tracks the book (2–5s polls) instead of trailing by up to one candle.
 *
 * The history series arrives in unix SECONDS from the CLOB (sparklines too);
 * evaluation timestamps are ms — the unit is detected from the series itself
 * and the appended point uses the same unit. AreaChart spaces points by index,
 * so one appended point cannot distort the x-axis.
 */

export interface LiveQuote {
  bestBid: number | null;
  bestAsk: number | null;
  /** Quote age at the moment it was received; null/undefined = fresh. */
  dataAgeMs?: number | null;
}

/** Book midpoint; one-sided books fall back to the side that exists. */
export const liveMid = (quote: LiveQuote | null | undefined): number | null => {
  if (!quote) return null;
  const { bestBid, bestAsk } = quote;
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  return bestAsk ?? bestBid ?? null;
};

/** Never draw a book this old as the chart's newest point. */
const MAX_LIVE_AGE_MS = 60_000;

export function spliceLive(
  series: ChartPoint[],
  quote: LiveQuote | null | undefined,
  nowMs: number,
): { series: ChartPoint[]; spliced: boolean } {
  const mid = liveMid(quote);
  const ageMs = quote?.dataAgeMs ?? 0;
  if (mid == null || series.length < 1 || ageMs > MAX_LIVE_AGE_MS) {
    return { series, spliced: false };
  }

  const inSeconds = series[series.length - 1]!.t < 1e12;
  const liveTMs = nowMs - ageMs;
  const liveT = inSeconds ? Math.floor(liveTMs / 1000) : liveTMs;

  // Drop any trailing points at/after the live moment (candle-boundary or
  // clock-skew artifacts) so the appended point can never render backwards.
  let end = series.length;
  while (end > 0 && series[end - 1]!.t >= liveT) end--;
  if (end === 0) return { series, spliced: false }; // whole history "in the future" — skew, bail

  const kept = series.slice(0, end);
  const lastT = kept[kept.length - 1]!.t;
  return {
    series: [...kept, { t: Math.max(lastT + 1, liveT), v: mid }],
    spliced: true,
  };
}
