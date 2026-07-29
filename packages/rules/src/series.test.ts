import { describe, it, expect } from "vitest";
import {
  entryCeilingOf,
  modelRollingOutcomes,
  resolvedOrderAction,
  revertRepeatForSkip,
  seriesGuardDecision,
  SERIES_SKIP_REARM_MS,
  type ResolvedSeriesWindow,
} from "./series.js";
import type { FeeSchedule } from "./fees.js";
import type { OrderActionV2, SeriesRef, StrategyRuntime } from "./types-v2.js";

const NOW = Date.parse("2026-07-27T13:21:00Z");
const MIN = 60_000;

const seriesRef = (over: Partial<SeriesRef> = {}): SeriesRef => ({
  kind: "series",
  seriesSlug: "btc-up-or-down-5m",
  outcome: "Up",
  selector: "current",
  maxEntryPrice: 0.6,
  ...over,
});

const orderAction = (over: Partial<OrderActionV2> = {}): OrderActionV2 => ({
  kind: "order",
  market: { conditionId: "anchor-cond", tokenId: "anchor-token", outcome: "Up" },
  rollingSeries: seriesRef(),
  side: "BUY",
  price: 0.6,
  size: 50,
  orderType: "FAK",
  execution: "prepare",
  ...over,
});

const windowAt = (over: Partial<ResolvedSeriesWindow> = {}): ResolvedSeriesWindow => ({
  market: {
    conditionId: "cond-live",
    tokenId: "token-live",
    outcome: "Up",
    title: "BTC 9:20–9:25",
  },
  windowStartMs: NOW - MIN,
  windowEndMs: NOW + 4 * MIN,
  bestAsk: 0.51,
  slug: "btc-updown-5m-1785158400",
  ...over,
});

describe("seriesGuardDecision", () => {
  const decide = (
    over: {
      action?: Partial<OrderActionV2>;
      window?: ResolvedSeriesWindow | null;
      lastTradedWindowStartMs?: number | null;
    } = {},
  ) =>
    seriesGuardDecision({
      action: orderAction(over.action),
      window: over.window === undefined ? windowAt() : over.window,
      nowMs: NOW,
      lastTradedWindowStartMs: over.lastTradedWindowStartMs ?? null,
    });

  it("enters a live, cheap window at the ceiling as a marketable limit", () => {
    const d = decide();
    expect(d.ok).toBe(true);
    // Never pays above the user's own guard, even though the ask is lower.
    if (d.ok) expect(d.entryPrice).toBe(0.6);
  });

  it("skips when the entry side trades above the ceiling", () => {
    const d = decide({ window: windowAt({ bestAsk: 0.72 }) });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("series_price_above_ceiling");
      expect(d.detail).toMatchObject({ bestAsk: 0.72, ceiling: 0.6 });
    }
  });

  it("skips a window about to close", () => {
    const d = decide({ window: windowAt({ windowEndMs: NOW + 10_000 }) });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("series_window_too_short");
      expect(d.detail).toMatchObject({ remainingMs: 10_000, requiredMs: 30_000 });
    }
  });

  it("honours a custom time floor", () => {
    const action = { rollingSeries: seriesRef({ minRemainingMs: 5_000 }) };
    const d = decide({ action, window: windowAt({ windowEndMs: NOW + 10_000 }) });
    expect(d.ok).toBe(true);
  });

  it("never enters the same window twice", () => {
    const w = windowAt();
    const d = decide({ window: w, lastTradedWindowStartMs: w.windowStartMs });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("series_window_already_traded");
  });

  it("fails closed on an unresolved window or an empty book", () => {
    const unresolved = decide({ window: null });
    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) expect(unresolved.reason).toBe("series_unresolved");

    const noBook = decide({ window: windowAt({ bestAsk: null }) });
    expect(noBook.ok).toBe(false);
    if (!noBook.ok) expect(noBook.reason).toBe("series_no_book");
  });

  it("falls back to the order's own price as the ceiling", () => {
    const { maxEntryPrice: _omitted, ...noCeiling } = seriesRef();
    const action = orderAction({ price: 0.42, rollingSeries: noCeiling });
    expect(entryCeilingOf(action)).toBe(0.42);
    const d = seriesGuardDecision({
      action,
      window: windowAt({ bestAsk: 0.5 }),
      nowMs: NOW,
      lastTradedWindowStartMs: null,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("series_price_above_ceiling");
  });
});

describe("resolvedOrderAction", () => {
  it("produces a concrete order with no rolling binding left on it", () => {
    const resolved = resolvedOrderAction(orderAction(), windowAt(), 0.6);
    expect(resolved.market.tokenId).toBe("token-live");
    expect(resolved.price).toBe(0.6);
    expect(resolved.size).toBe(50);
    expect(resolved.orderType).toBe("FAK");
    // The prepared action must be unambiguously executable.
    expect(resolved.rollingSeries).toBeUndefined();
    expect("rollingSeries" in resolved).toBe(false);
  });
});

describe("revertRepeatForSkip", () => {
  it("gives the repeat back and holds a short re-arm cooldown", () => {
    const after = {
      status: "ACTIVE_WAITING",
      triggerCount: 2,
      trueSinceMs: NOW - 5_000,
      cooldownUntilMs: NOW + 600_000,
    } as StrategyRuntime;
    const reverted = revertRepeatForSkip(after, 1, NOW);
    expect(reverted.triggerCount).toBe(1);
    expect(reverted.cooldownUntilMs).toBe(NOW + SERIES_SKIP_REARM_MS);
    expect(reverted.status).toBe("ACTIVE_WAITING");
    // The hold window restarts — a skip is not a half-finished trigger.
    expect(reverted.trueSinceMs).toBeNull();
  });

  it("returns a prepare-order strategy to waiting instead of awaiting-user", () => {
    const after = {
      status: "TRIGGERED_AWAITING_USER",
      triggerCount: 1,
      cooldownUntilMs: null,
    } as StrategyRuntime;
    const reverted = revertRepeatForSkip(after, 0, NOW);
    expect(reverted.status).toBe("ACTIVE_WAITING");
    expect(reverted.triggerCount).toBe(0);
  });
});

describe("modelRollingOutcomes", () => {
  const crypto: FeeSchedule = { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.25 };

  it("prices an all-or-nothing entry: win, loss and worst case", () => {
    // 50 shares at 60¢ = $30 stake. A win pays $50 → +$20 gross.
    const m = modelRollingOutcomes({
      shares: 50,
      entryPrice: 0.6,
      windows: 3,
      feeSchedule: null,
    });
    expect(m.costPerWindowUsd).toBeCloseTo(30, 6);
    expect(m.winPerWindowUsd).toBeCloseTo(20, 6);
    expect(m.lossPerWindowUsd).toBeCloseTo(30, 6);
    expect(m.maxSpendUsd).toBeCloseTo(90, 6);
    expect(m.bestCaseUsd).toBeCloseTo(60, 6);
    // The worst case is exactly the money that can leave the account.
    expect(m.worstCaseUsd).toBeCloseTo(-90, 6);
  });

  it("charges the taker fee against both the cost and the win", () => {
    const free = modelRollingOutcomes({
      shares: 50,
      entryPrice: 0.6,
      windows: 1,
      feeSchedule: null,
    });
    const fee = modelRollingOutcomes({
      shares: 50,
      entryPrice: 0.6,
      windows: 1,
      feeSchedule: crypto,
    });
    expect(fee.costPerWindowUsd).toBeGreaterThan(free.costPerWindowUsd);
    expect(fee.winPerWindowUsd).toBeLessThan(free.winPerWindowUsd);
  });

  it("reports the break-even win rate as price plus fee per share", () => {
    const noFee = modelRollingOutcomes({
      shares: 100,
      entryPrice: 0.6,
      windows: 1,
      feeSchedule: null,
    });
    // At 60¢ with no fees you must be right 60% of the time.
    expect(noFee.breakEvenWinRate).toBeCloseTo(0.6, 6);

    const withFee = modelRollingOutcomes({
      shares: 100,
      entryPrice: 0.6,
      windows: 1,
      feeSchedule: crypto,
    });
    expect(withFee.breakEvenWinRate).toBeGreaterThan(0.6);
    expect(withFee.breakEvenWinRate).toBeLessThan(1);
  });

  it("scales linearly with the window budget", () => {
    const one = modelRollingOutcomes({
      shares: 20,
      entryPrice: 0.4,
      windows: 1,
      feeSchedule: null,
    });
    const five = modelRollingOutcomes({
      shares: 20,
      entryPrice: 0.4,
      windows: 5,
      feeSchedule: null,
    });
    expect(five.maxSpendUsd).toBeCloseTo(one.maxSpendUsd * 5, 6);
    expect(five.bestCaseUsd).toBeCloseTo(one.bestCaseUsd * 5, 6);
  });
});
