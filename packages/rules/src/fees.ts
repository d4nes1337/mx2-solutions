/**
 * Polymarket trading-fee math (pure). Since Fee Structure V2 (2026-03-30)
 * most categories charge TAKER-ONLY fees computed by the protocol at match
 * time: fee = shares × rate × (p·(1−p))^exponent — symmetric around 50% and
 * approaching zero near the extremes. Makers pay nothing and instead accrue
 * the Maker Rebates Program share (`rebateRate` of collected taker fees,
 * pro-rata to executed maker volume). Verified against
 * docs.polymarket.com/trading/fees, 2026-07-15.
 *
 * A schedule is per-market (CLOB `fd` on /clob-markets/{condition_id}, or
 * Gamma `feeSchedule`). null schedule = unknown — callers must render
 * "fee unknown", never assume zero.
 */
import type { BookLevel, Side } from "./types.js";
import { round6 } from "./predicates.js";

export interface FeeSchedule {
  /** Fee rate (e.g. 0.07 crypto, 0.05 sports, 0.04 politics, 0 geopolitics). */
  readonly rate: number;
  /** Fee curve exponent applied to p(1−p) (1 today). */
  readonly exponent: number;
  /** True on every fee-enabled market today: makers pay nothing. */
  readonly takerOnly: boolean;
  /** Maker Rebates Program share of collected taker fees (0.15–0.25), if any. */
  readonly rebateRate: number | null;
}

/** Taker fee in USD for `shares` filled at probability price `price`. */
export const takerFeeUsd = (shares: number, price: number, s: FeeSchedule): number => {
  if (!(shares > 0) || !(price > 0 && price < 1)) return 0;
  return round6(shares * s.rate * Math.pow(price * (1 - price), s.exponent));
};

export interface TakerCrossCost {
  /** Shares actually available at or better than the limit price. */
  readonly fillableShares: number;
  /** Volume-weighted average fill price. */
  readonly avgPrice: number;
  /** Taker fee across the fills (0 when the schedule is null). */
  readonly feeUsd: number;
  /**
   * Price-impact cost vs filling everything at the touch:
   * (avgPrice − bestPrice) × fillableShares for BUY (mirrored for SELL).
   */
  readonly impactUsd: number;
  /** Total USD paid (BUY) or received (SELL) for the fills, before fees. */
  readonly notionalUsd: number;
}

/**
 * Walk the opposing book to estimate what a marketable (FOK/FAK-style) order
 * really costs: fills, VWAP, price impact and the taker fee. `levels` is the
 * side being consumed — asks for BUY, bids for SELL — best-first.
 */
export const takerCrossCost = (
  levels: readonly BookLevel[],
  side: Side,
  limitPrice: number,
  shares: number,
  schedule: FeeSchedule | null,
): TakerCrossCost => {
  let remaining = shares;
  let notional = 0;
  let feeUsd = 0;
  const best = levels[0]?.price ?? null;

  for (const level of levels) {
    if (remaining <= 0) break;
    const priceOk = side === "BUY" ? level.price <= limitPrice : level.price >= limitPrice;
    if (!priceOk) break;
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    if (schedule) feeUsd += takerFeeUsd(take, level.price, schedule);
    remaining -= take;
  }

  const fillable = shares - remaining;
  const avgPrice = fillable > 0 ? notional / fillable : 0;
  const impactUsd =
    fillable > 0 && best !== null
      ? Math.abs(avgPrice - best) * fillable
      : 0;

  return {
    fillableShares: round6(fillable),
    avgPrice: round6(avgPrice),
    feeUsd: round6(feeUsd),
    impactUsd: round6(impactUsd),
    notionalUsd: round6(notional),
  };
};
