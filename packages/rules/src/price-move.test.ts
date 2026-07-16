/**
 * price_move: pure predicate math, fail-closed evaluation (the load-bearing
 * NOT-safety case), and backtest simulation vs a brute-force reference.
 */
import { describe, expect, it } from "vitest";
import { priceMove } from "./predicates.js";
import { evaluateExpression } from "./evaluate-v2.js";
import { simulateTriggers, type PricePoint } from "./simulate.js";
import type { MarketDataView, PriceSample } from "./types.js";
import type { ExprNode, PriceMoveConditionV2, StrategyDefinition } from "./types-v2.js";
import { validateStrategyDefinition } from "./validate-v2.js";

const MARKET = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };

const view = (history: PriceSample[] | undefined, nowMs: number): MarketDataView => ({
  tokenId: "tok-1",
  conditionId: "cond-1",
  bids: [{ price: 0.4, size: 100 }],
  asks: [{ price: 0.42, size: 100 }],
  marketStatus: "open",
  sourceTimeMs: nowMs,
  receivedAtMs: nowMs,
  ...(history ? { priceHistory: history } : {}),
});

const moveCond = (over: Partial<PriceMoveConditionV2> = {}): PriceMoveConditionV2 => ({
  kind: "price_move",
  market: MARKET,
  direction: "drop",
  deltaThreshold: 0.05,
  windowMs: 300_000,
  ...over,
});

const defWith = (expr: ExprNode): StrategyDefinition => ({
  version: 2,
  name: "t",
  templateId: null,
  expr,
  holdsForMs: 0,
  maxDataAgeMs: 5_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
});

describe("priceMove predicate", () => {
  const now = 1_000_000_000;

  it("null without any history", () => {
    expect(priceMove(view(undefined, now), 300_000, now)).toBeNull();
    expect(priceMove(view([], now), 300_000, now)).toBeNull();
  });

  it("null without a carry-in sample at/before the window start", () => {
    // All samples strictly inside the window — coverage unknown before it.
    const hist = [
      { t: now - 200_000, p: 0.5 },
      { t: now - 100_000, p: 0.45 },
    ];
    expect(priceMove(view(hist, now), 300_000, now)).toBeNull();
  });

  it("carry-in exactly at the window start counts as coverage", () => {
    const hist = [
      { t: now - 300_000, p: 0.5 }, // exactly at start → carry-in
      { t: now - 100_000, p: 0.44 },
    ];
    const m = priceMove(view(hist, now), 300_000, now);
    expect(m).not.toBeNull();
    expect(m!.drop).toBeCloseTo(0.06, 6);
    expect(m!.rise).toBeCloseTo(0, 6);
  });

  it("null when the window has a carry-in but no samples inside", () => {
    const hist = [{ t: now - 400_000, p: 0.5 }];
    expect(priceMove(view(hist, now), 300_000, now)).toBeNull();
  });

  it("drop measures max→last, rise measures last→min, carry-in included in extremes", () => {
    const hist = [
      { t: now - 400_000, p: 0.6 }, // carry-in (highest)
      { t: now - 250_000, p: 0.5 },
      { t: now - 150_000, p: 0.45 }, // window min
      { t: now - 50_000, p: 0.52 }, // last
    ];
    const m = priceMove(view(hist, now), 300_000, now)!;
    expect(m.drop).toBeCloseTo(0.08, 6); // 0.60 → 0.52
    expect(m.rise).toBeCloseTo(0.07, 6); // 0.45 → 0.52
    expect(m.last).toBeCloseTo(0.52, 6);
  });

  it("ignores samples after nowMs (skew safety)", () => {
    const hist = [
      { t: now - 400_000, p: 0.5 },
      { t: now - 100_000, p: 0.48 },
      { t: now + 60_000, p: 0.1 }, // future — must not count
    ];
    const m = priceMove(view(hist, now), 300_000, now)!;
    expect(m.drop).toBeCloseTo(0.02, 6);
  });
});

describe("evaluateExpression with price_move", () => {
  const now = 2_000_000_000;
  const covered: PriceSample[] = [
    { t: now - 400_000, p: 0.55 },
    { t: now - 120_000, p: 0.48 },
  ];

  it("satisfied on a fresh, covered drop ≥ threshold", () => {
    const def = defWith({
      type: "group",
      id: "root",
      op: "and",
      children: [{ type: "condition", id: "c1", condition: moveCond() }],
    });
    const res = evaluateExpression(def, { "tok-1": view(covered, now) }, now);
    expect(res.satisfied).toBe(true);
    expect(res.reasonCodes).toContain("PRICE_MOVE_OK");
  });

  it("incomplete window → unsatisfied + stale (fail-closed)", () => {
    const def = defWith({
      type: "group",
      id: "root",
      op: "and",
      children: [{ type: "condition", id: "c1", condition: moveCond() }],
    });
    const res = evaluateExpression(def, { "tok-1": view([], now) }, now);
    expect(res.satisfied).toBe(false);
    expect(res.staleTokenIds).toContain("tok-1");
    expect(res.reasonCodes).toContain("PRICE_MOVE_WINDOW_INCOMPLETE");
  });

  it("NOT(price_move) cannot fire on an incomplete window — the load-bearing case", () => {
    const def = defWith({
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "group",
          id: "n1",
          op: "not",
          children: [{ type: "condition", id: "c1", condition: moveCond() }],
        },
      ],
    });
    // Incomplete window: the NOT branch is nominally satisfied (child false),
    // but the global stale override must keep the root unsatisfied.
    const res = evaluateExpression(def, { "tok-1": view([], now) }, now);
    expect(res.root.satisfied).toBe(true); // tree says yes…
    expect(res.satisfied).toBe(false); // …the verdict says no.
  });
});

describe("validate price_move", () => {
  const build = (over: Partial<PriceMoveConditionV2>) =>
    defWith({
      type: "group",
      id: "root",
      op: "and",
      children: [{ type: "condition", id: "c1", condition: moveCond(over) }],
    });

  it("accepts a sane condition", () => {
    expect(validateStrategyDefinition(build({}))).toHaveLength(0);
  });

  it("rejects out-of-range windows and deltas", () => {
    expect(validateStrategyDefinition(build({ windowMs: 30_000 })).map((i) => i.code)).toContain(
      "PRICE_MOVE_WINDOW_OUT_OF_RANGE",
    );
    expect(validateStrategyDefinition(build({ windowMs: 7_200_000 })).map((i) => i.code)).toContain(
      "PRICE_MOVE_WINDOW_OUT_OF_RANGE",
    );
    expect(validateStrategyDefinition(build({ deltaThreshold: 0 })).map((i) => i.code)).toContain(
      "PRICE_OUT_OF_RANGE",
    );
  });
});

describe("simulateTriggers with price_move", () => {
  const t0 = 1_700_000_000_000;
  const minute = 60_000;

  const seriesOf = (prices: number[]): PricePoint[] =>
    prices.map((p, i) => ({ t: t0 + i * minute, p }));

  const spikeDef = (windowMs: number, delta: number): Parameters<typeof simulateTriggers>[0] => ({
    expr: {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: moveCond({ windowMs, deltaThreshold: delta }),
        },
      ],
    },
    holdsForMs: 0,
    recurrence: { kind: "once" },
    action: { kind: "alert" },
    series: [],
  });

  it("fires on a spike and marks PnL to the final price", () => {
    // Flat at 0.50 for 10 min, crash to 0.40, recover to 0.45.
    const series = seriesOf([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.4, 0.45]);
    const res = simulateTriggers({ ...spikeDef(5 * minute, 0.08), series });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers.length).toBe(1);
    expect(res.triggers[0]!.price).toBeCloseTo(0.4, 6);
  });

  it("matches a brute-force reference on random series", () => {
    // Deterministic pseudo-random walk.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const prices: number[] = [0.5];
    for (let i = 1; i < 300; i++) {
      const next = Math.min(0.95, Math.max(0.05, prices[i - 1]! + (rand() - 0.5) * 0.04));
      prices.push(Number(next.toFixed(4)));
    }
    const series = seriesOf(prices);
    const windowMs = 10 * minute;
    const delta = 0.05;

    const res = simulateTriggers({ ...spikeDef(windowMs, delta), series, holdsForMs: 0 });
    expect(res.supported).toBe(true);
    if (!res.supported) return;

    // Brute force: first sample where (max over trailing window incl. carry-in) − p ≥ delta.
    let expected: number | null = null;
    for (let i = 0; i < series.length; i++) {
      const start = series[i]!.t - windowMs;
      const carryIdx = series.findLastIndex((s) => s.t <= start);
      if (carryIdx < 0) continue;
      let max = -Infinity;
      for (let j = carryIdx; j <= i; j++) {
        if (series[j]!.t <= start && j !== carryIdx) continue;
        max = Math.max(max, series[j]!.p);
      }
      if (max - series[i]!.p >= delta) {
        expected = series[i]!.t;
        break;
      }
    }
    expect(res.triggers[0]?.t ?? null).toBe(expected);
  });

  it("refuses sub-resolution windows honestly", () => {
    const series = seriesOf([0.5, 0.4, 0.5, 0.4, 0.5, 0.4]);
    const res = simulateTriggers({ ...spikeDef(1.5 * minute, 0.05), series });
    // Median gap 60s > 90s/2 = 45s → window_too_fine.
    expect(res).toEqual({ supported: false, reason: "window_too_fine" });
  });
});
