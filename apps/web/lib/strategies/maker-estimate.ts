/**
 * Reward-aware maker estimator (U8, estimator-first per D-019). Pure and
 * deliberately conservative: it tells the user whether a resting quote WOULD
 * QUALIFY for Polymarket's liquidity-rewards program and what it costs/locks.
 * Per-market daily pool rates ARE readable (CLOB /rewards/markets — surfaced
 * by the economics endpoint and shown alongside this estimate), but the
 * user's SHARE of a pool depends on competing qualifying liquidity, so no
 * personal dollar amount is promised. Never suggests self-trading or wash
 * behavior.
 */

export interface MakerEstimateInput {
  /** Resting quote price (probability 0–1) and size in shares. */
  price: number;
  size: number;
  side: "BUY" | "SELL";
  /** Live top of book (nulls when unknown). */
  bestBid: number | null;
  bestAsk: number | null;
  /** Market rewards params (Gamma; cents for maxSpread). Null = unknown. */
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
}

export interface MakerEstimate {
  /** Capital committed while the quote rests (USD). */
  capitalUsd: number;
  /** Distance from mid in cents (null when the book is unknown). */
  distanceFromMidCents: number | null;
  /** Program qualification verdicts (null = can't tell). */
  meetsMinSize: boolean | null;
  withinMaxSpread: boolean | null;
  qualifies: boolean | null;
  /** Rough fill-likelihood band from quote aggressiveness. An estimate. */
  fillLikelihood: "high" | "medium" | "low" | "unknown";
  /** Worst-case loss if filled and the market resolves against you (USD). */
  maxDownsideUsd: number;
  notes: string[];
}

export const estimateMakerQuote = (input: MakerEstimateInput): MakerEstimate => {
  const { price, size, side, bestBid, bestAsk, rewardsMinSize, rewardsMaxSpread } = input;
  const capitalUsd = side === "BUY" ? price * size : (1 - price) * size;

  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const distanceFromMidCents = mid === null ? null : Math.abs(price - mid) * 100;

  const meetsMinSize = rewardsMinSize === null ? null : size >= rewardsMinSize;
  const withinMaxSpread =
    rewardsMaxSpread === null || distanceFromMidCents === null
      ? null
      : distanceFromMidCents <= rewardsMaxSpread;
  const qualifies =
    meetsMinSize === null || withinMaxSpread === null ? null : meetsMinSize && withinMaxSpread;

  // Aggressiveness heuristic: a BUY at/above best bid (or SELL at/below best
  // ask) sits at the front of the queue; deeper quotes fill less often.
  let fillLikelihood: MakerEstimate["fillLikelihood"] = "unknown";
  if (mid !== null && bestBid !== null && bestAsk !== null) {
    const reference = side === "BUY" ? bestBid : bestAsk;
    const improvement = side === "BUY" ? price - reference : reference - price;
    fillLikelihood = improvement >= 0 ? "high" : improvement > -0.02 ? "medium" : "low";
  }

  // Binary-outcome worst case: a filled BUY at p loses p·size if it resolves
  // NO; a filled SELL loses (1−p)·size if it resolves YES.
  const maxDownsideUsd = capitalUsd;

  const notes: string[] = [
    "Your share of a rewards pool depends on competing qualifying liquidity, so no personal dollar amount is promised.",
    "If the quote fills you hold a real position; the downside shown assumes the worst resolution.",
  ];
  if (qualifies === false && meetsMinSize === false)
    notes.unshift("Increase the size to reach the program's minimum resting size.");
  if (qualifies === false && withinMaxSpread === false)
    notes.unshift("Move the quote closer to the mid price to qualify for rewards.");
  if (rewardsMinSize === null && rewardsMaxSpread === null)
    notes.unshift("This market does not advertise maker-rewards parameters.");

  return {
    capitalUsd,
    distanceFromMidCents,
    meetsMinSize,
    withinMaxSpread,
    qualifies,
    fillLikelihood,
    maxDownsideUsd,
    notes,
  };
};
