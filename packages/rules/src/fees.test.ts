/**
 * Fee Structure V2 math: fee = shares · rate · (p(1−p))^exponent, verified
 * against docs.polymarket.com/trading/fees worked figures (peak fee per 100
 * shares at p=0.5: crypto $1.75, sports $1.25, politics $1.00).
 */
import { describe, expect, it } from "vitest";
import { takerCrossCost, takerFeeUsd, type FeeSchedule } from "./fees.js";
import type { BookLevel } from "./types.js";

const schedule = (rate: number, exponent = 1): FeeSchedule => ({
  rate,
  exponent,
  takerOnly: true,
  rebateRate: null,
});

describe("takerFeeUsd", () => {
  it("matches the official per-category peaks at p=0.5 for 100 shares", () => {
    expect(takerFeeUsd(100, 0.5, schedule(0.07))).toBeCloseTo(1.75, 6); // crypto
    expect(takerFeeUsd(100, 0.5, schedule(0.05))).toBeCloseTo(1.25, 6); // sports
    expect(takerFeeUsd(100, 0.5, schedule(0.04))).toBeCloseTo(1.0, 6); // politics
    expect(takerFeeUsd(100, 0.5, schedule(0))).toBe(0); // geopolitics
  });

  it("is symmetric around 50% and approaches zero at the extremes", () => {
    const s = schedule(0.05);
    expect(takerFeeUsd(100, 0.2, s)).toBeCloseTo(takerFeeUsd(100, 0.8, s), 9);
    expect(takerFeeUsd(100, 0.01, s)).toBeLessThan(0.06);
  });

  it("applies the exponent to p(1−p)", () => {
    // e=2: 100 · 0.05 · (0.25)² = 0.3125
    expect(takerFeeUsd(100, 0.5, schedule(0.05, 2))).toBeCloseTo(0.3125, 6);
  });

  it("guards junk inputs", () => {
    const s = schedule(0.05);
    expect(takerFeeUsd(0, 0.5, s)).toBe(0);
    expect(takerFeeUsd(100, 0, s)).toBe(0);
    expect(takerFeeUsd(100, 1, s)).toBe(0);
  });
});

describe("takerCrossCost", () => {
  const asks: BookLevel[] = [
    { price: 0.5, size: 100 },
    { price: 0.52, size: 200 },
    { price: 0.6, size: 500 },
  ];

  it("walks levels within the limit and reports VWAP + impact + fee", () => {
    const c = takerCrossCost(asks, "BUY", 0.55, 250, schedule(0.04));
    // Fills 100 @ .50 + 150 @ .52 — the .60 level is beyond the limit.
    expect(c.fillableShares).toBe(250);
    expect(c.notionalUsd).toBeCloseTo(100 * 0.5 + 150 * 0.52, 6);
    expect(c.avgPrice).toBeCloseTo((100 * 0.5 + 150 * 0.52) / 250, 6);
    expect(c.impactUsd).toBeCloseTo((c.avgPrice - 0.5) * 250, 5);
    const expectedFee =
      takerFeeUsd(100, 0.5, schedule(0.04)) + takerFeeUsd(150, 0.52, schedule(0.04));
    expect(c.feeUsd).toBeCloseTo(expectedFee, 6);
  });

  it("reports partial fillability against a thin book", () => {
    const c = takerCrossCost(asks, "BUY", 0.5, 500, schedule(0.04));
    expect(c.fillableShares).toBe(100); // only the .50 level is at/under the limit
  });

  it("null schedule → zero fee reported (cost display says 'unknown')", () => {
    const c = takerCrossCost(asks, "BUY", 0.55, 100, null);
    expect(c.feeUsd).toBe(0);
    expect(c.fillableShares).toBe(100);
  });

  it("SELL walks bids at/above the limit and stops below it", () => {
    const bids: BookLevel[] = [
      { price: 0.48, size: 100 },
      { price: 0.45, size: 100 }, // below the 46¢ limit — never hit
    ];
    const c = takerCrossCost(bids, "SELL", 0.46, 150, schedule(0.05));
    expect(c.fillableShares).toBe(100);
    expect(c.notionalUsd).toBeCloseTo(100 * 0.48, 6);
  });
});
