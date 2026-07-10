import { describe, expect, it } from "vitest";
import type { ExprNode, MarketRef } from "./types-v2.js";
import { backtestTokenId, simulateTriggers, type PricePoint } from "./simulate.js";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };
const otherMarket: MarketRef = { conditionId: "cond-2", tokenId: "tok-2", outcome: "YES" };

const priceBelow = (threshold: number, m: MarketRef = market): ExprNode => ({
  type: "condition",
  id: `c-${threshold}`,
  condition: { kind: "price", market: m, source: "ask", comparator: "lte", threshold },
});

const group = (op: "and" | "or" | "not", children: ExprNode[]): ExprNode => ({
  type: "group",
  id: "root",
  op,
  children,
});

const alert = { kind: "alert" } as const;
const once = { kind: "once" } as const;

/** One sample per minute starting at a fixed epoch (ms). */
const T0 = 1_750_000_000_000;
const series = (prices: number[]): PricePoint[] =>
  prices.map((p, i) => ({ t: T0 + i * 60_000, p }));

describe("backtestTokenId", () => {
  it("accepts single-market price(+time_window) strategies", () => {
    expect(backtestTokenId(group("and", [priceBelow(0.5)]))).toBe("tok-1");
  });

  it("rejects multi-market strategies", () => {
    expect(
      backtestTokenId(group("and", [priceBelow(0.5), priceBelow(0.7, otherMarket)])),
    ).toBeNull();
  });

  it("rejects strategies with unsupported condition kinds", () => {
    const withSpread = group("and", [
      priceBelow(0.5),
      {
        type: "condition",
        id: "sp",
        condition: { kind: "spread", market, comparator: "lte", threshold: 0.02 },
      },
    ]);
    expect(backtestTokenId(withSpread)).toBeNull();
  });
});

describe("simulateTriggers", () => {
  it("fires once the condition holds continuously for holdsForMs", () => {
    // Dips below 0.5 at samples 3..6 (4 samples = 3 minutes of continuous hold).
    const s = series([0.6, 0.58, 0.55, 0.48, 0.47, 0.46, 0.49, 0.55, 0.6, 0.62]);
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.5)]),
      holdsForMs: 2 * 60_000,
      recurrence: once,
      action: alert,
      series: s,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1);
    // satisfied since sample 3; 2 minutes later = sample 5.
    expect(res.triggers[0]!.t).toBe(T0 + 5 * 60_000);
    expect(res.triggers[0]!.price).toBeCloseTo(0.46);
  });

  it("resets the hold window when the condition breaks", () => {
    // Never holds for 2 consecutive minutes below 0.5.
    const s = series([0.48, 0.52, 0.48, 0.52, 0.48, 0.52, 0.48, 0.52]);
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.5)]),
      holdsForMs: 2 * 60_000,
      recurrence: once,
      action: alert,
      series: s,
    });
    expect(res.supported && res.triggers.length).toBe(0);
  });

  it("respects repeat recurrence with cooldown and maxRepeats", () => {
    // Two dip episodes separated by a recovery.
    const s = series([0.4, 0.4, 0.4, 0.7, 0.7, 0.4, 0.4, 0.4, 0.7, 0.4, 0.4, 0.4]);
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.5)]),
      holdsForMs: 60_000,
      recurrence: { kind: "repeat", maxRepeats: 2, cooldownMs: 60_000 },
      action: alert,
      series: s,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(2);
  });

  it("computes hypothetical PnL for alerts as $100 buys at the trigger price", () => {
    // Trigger at 0.40 (holdsFor 0), final price 0.60 → 250 shares · 0.20 = +$50.
    const s = series([0.6, 0.4, 0.5, 0.6]);
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.45)]),
      holdsForMs: 0,
      recurrence: once,
      action: alert,
      series: s,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1);
    expect(res.hypotheticalPnlUsd).toBeCloseTo(50);
  });

  it("computes order PnL from the limit price and share size (SELL inverts)", () => {
    const s = series([0.6, 0.4, 0.5, 0.6]);
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.45)]),
      holdsForMs: 0,
      recurrence: once,
      action: {
        kind: "order",
        market,
        side: "SELL",
        price: 0.42,
        size: 100,
        orderType: "GTC",
        execution: "prepare",
      },
      series: s,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    // SELL 100 at 0.42, final 0.60 → (0.42 − 0.60)·100 = −$18.
    expect(res.hypotheticalPnlUsd).toBeCloseTo(-18);
  });

  it("supports NOT groups", () => {
    // NOT(price ≥ 0.5) === price < 0.5.
    const notExpr = group("not", [
      {
        type: "condition",
        id: "hi",
        condition: { kind: "price", market, source: "ask", comparator: "gte", threshold: 0.5 },
      },
    ]);
    const s = series([0.6, 0.4, 0.4, 0.6]);
    const res = simulateTriggers({
      expr: notExpr,
      holdsForMs: 0,
      recurrence: once,
      action: alert,
      series: s,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1);
  });

  it("returns unsupported for multi-market or empty series", () => {
    expect(
      simulateTriggers({
        expr: group("and", [priceBelow(0.5), priceBelow(0.7, otherMarket)]),
        holdsForMs: 0,
        recurrence: once,
        action: alert,
        series: series([0.5, 0.5]),
      }),
    ).toMatchObject({ supported: false, reason: "multi_market" });

    expect(
      simulateTriggers({
        expr: group("and", [priceBelow(0.5)]),
        holdsForMs: 0,
        recurrence: once,
        action: alert,
        series: [],
      }),
    ).toMatchObject({ supported: false, reason: "no_data" });
  });

  it("breaks the hold window across large series gaps", () => {
    // 3 low samples, a 30-minute hole, then 1 low sample: the hole must reset
    // the continuity clock, so a 3-minute hold never completes.
    const pts: PricePoint[] = [
      { t: T0, p: 0.4 },
      { t: T0 + 60_000, p: 0.4 },
      { t: T0 + 120_000, p: 0.4 },
      { t: T0 + 30 * 60_000, p: 0.4 },
      { t: T0 + 31 * 60_000, p: 0.6 },
    ];
    const res = simulateTriggers({
      expr: group("and", [priceBelow(0.5)]),
      holdsForMs: 3 * 60_000,
      recurrence: once,
      action: alert,
      series: pts,
    });
    expect(res.supported && res.triggers.length).toBe(0);
  });
});
