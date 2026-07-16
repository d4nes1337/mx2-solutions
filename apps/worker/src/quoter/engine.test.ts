import { describe, expect, it } from "vitest";
import type { MarketDataView, QuoteLoopAction } from "@mx2/rules";
import {
  capBreach,
  capitalCommittedUsd,
  computeDesiredQuotes,
  diffQuotes,
  inventoryPlan,
  roundDownToTick,
  type DesiredQuotes,
  type RestingQuote,
} from "./engine.js";

const params = (over: Partial<QuoteLoopAction> = {}): QuoteLoopAction => ({
  kind: "quote_loop",
  market: {
    conditionId: "cond-1",
    yesTokenId: "tok-yes",
    noTokenId: "tok-no",
    tickSize: "0.01",
  },
  sizeShares: 100,
  targetSpreadCents: 2,
  requoteToleranceCents: 1,
  maxInventoryShares: 200,
  maxCapitalUsd: 500,
  maxDailyLossUsd: 25,
  ...over,
});

const view = (bid: number, ask: number, nowMs = 1_000_000): MarketDataView => ({
  tokenId: "tok-yes",
  conditionId: "cond-1",
  bids: [{ price: bid, size: 500 }],
  asks: [{ price: ask, size: 500 }],
  marketStatus: "open",
  sourceTimeMs: nowMs,
  receivedAtMs: nowMs,
});

describe("computeDesiredQuotes", () => {
  it("quotes YES at mid−s and NO at (1−mid)−s, tick-rounded down", () => {
    const d = computeDesiredQuotes(params(), view(0.49, 0.51), 1_000_000, 5_000);
    expect(d.kind).toBe("quote");
    if (d.kind !== "quote") return;
    expect(d.mid).toBeCloseTo(0.5, 9);
    expect(d.yesBid.price).toBeCloseTo(0.48, 9);
    expect(d.noBid.price).toBeCloseTo(0.48, 9);
    // Pair cost 0.96 < 1 → merging a filled pair earns 2s per pair.
    expect(d.yesBid.price + d.noBid.price).toBeLessThan(1);
  });

  it("idles on missing, stale, or empty books", () => {
    expect(computeDesiredQuotes(params(), undefined, 1_000_000, 5_000)).toEqual({
      kind: "idle",
      reason: "no_book",
    });
    expect(computeDesiredQuotes(params(), view(0.49, 0.51, 990_000), 1_000_000, 5_000)).toEqual({
      kind: "idle",
      reason: "stale_book",
    });
    const empty = { ...view(0.49, 0.51), bids: [], asks: [] };
    expect(computeDesiredQuotes(params(), empty, 1_000_000, 5_000)).toEqual({
      kind: "idle",
      reason: "no_book",
    });
  });

  it("idles near the extremes where a pinned quote breaks delta-neutrality", () => {
    const d = computeDesiredQuotes(params(), view(0.015, 0.025), 1_000_000, 5_000);
    expect(d).toEqual({ kind: "idle", reason: "mid_out_of_range" });
  });

  it("tick rounding is downward at coarse ticks", () => {
    expect(roundDownToTick(0.487, "0.1")).toBeCloseTo(0.4, 9);
    expect(roundDownToTick(0.487, "0.01")).toBeCloseTo(0.48, 9);
    expect(roundDownToTick(0.05, "0.1")).toBeCloseTo(0.1, 9); // floor clamps to one tick
  });
});

describe("diffQuotes — the anti-runaway invariant", () => {
  const desired = (): DesiredQuotes =>
    computeDesiredQuotes(params(), view(0.49, 0.51), 1_000_000, 5_000);

  it("diff(desired-as-resting, desired) = no-ops (idempotence property)", () => {
    // Sweep mids across the whole quotable range.
    for (let midCents = 6; midCents <= 94; midCents++) {
      const v = view(midCents / 100 - 0.01, midCents / 100 + 0.01);
      const d = computeDesiredQuotes(params(), v, 1_000_000, 5_000);
      if (d.kind !== "quote") continue;
      const resting: RestingQuote[] = [
        { ...d.yesBid, orderId: "a" },
        { ...d.noBid, orderId: "b" },
      ];
      const diff = diffQuotes(resting, d, params().requoteToleranceCents);
      expect(diff.cancels).toHaveLength(0);
      expect(diff.places).toHaveLength(0);
    }
  });

  it("keeps quotes within tolerance, re-places beyond it", () => {
    const d = desired();
    if (d.kind !== "quote") throw new Error("expected quotes");
    const withinTolerance: RestingQuote[] = [
      { ...d.yesBid, price: d.yesBid.price + 0.01, orderId: "a" }, // 1¢ = at tolerance
      { ...d.noBid, orderId: "b" },
    ];
    expect(diffQuotes(withinTolerance, d, 1).cancels).toHaveLength(0);

    const beyond: RestingQuote[] = [
      { ...d.yesBid, price: d.yesBid.price + 0.02, orderId: "a" },
      { ...d.noBid, orderId: "b" },
    ];
    const diff = diffQuotes(beyond, d, 1);
    expect(diff.cancels.map((c) => c.orderId)).toEqual(["a"]);
    expect(diff.places.map((p) => p.tokenId)).toEqual(["tok-yes"]);
  });

  it("idle cancels everything; duplicates and strays are cancelled", () => {
    const d = desired();
    if (d.kind !== "quote") throw new Error("expected quotes");
    const resting: RestingQuote[] = [
      { ...d.yesBid, orderId: "a" },
      { ...d.yesBid, orderId: "dup" },
      { tokenId: "tok-other", side: "BUY", price: 0.5, size: 10, orderId: "stray" },
    ];
    const idleDiff = diffQuotes(resting, { kind: "idle", reason: "gate_unsatisfied" }, 1);
    expect(idleDiff.cancels).toHaveLength(3);
    expect(idleDiff.places).toHaveLength(0);

    const activeDiff = diffQuotes(resting, d, 1);
    expect(activeDiff.cancels.map((c) => c.orderId).sort()).toEqual(["dup", "stray"]);
    // NO bid missing → placed; YES keeper survives.
    expect(activeDiff.places.map((p) => p.tokenId)).toEqual(["tok-no"]);
  });
});

describe("inventory + caps", () => {
  it("merges whole pairs once a quarter-quote accumulates", () => {
    expect(inventoryPlan(10, 8, params()).mergePairs).toBe(0); // 8 < 25 threshold
    expect(inventoryPlan(30, 27.5, params()).mergePairs).toBe(27);
    expect(inventoryPlan(30, 27.5, params()).netInventoryShares).toBeCloseTo(2.5, 9);
  });

  it("flags inventory breach on one-sided exposure", () => {
    expect(inventoryPlan(250, 10, params()).breach).toBe("inventory");
    expect(inventoryPlan(150, 10, params()).breach).toBeNull();
  });

  it("capital committed = resting notional + inventory at mid", () => {
    const resting: RestingQuote[] = [
      { tokenId: "tok-yes", side: "BUY", price: 0.48, size: 100, orderId: null },
      { tokenId: "tok-no", side: "BUY", price: 0.48, size: 100, orderId: null },
    ];
    const usd = capitalCommittedUsd(resting, 50, 20, 0.5);
    expect(usd).toBeCloseTo(0.48 * 200 + 50 * 0.5 + 20 * 0.5, 9);
  });

  it("cap breaches prefer daily-loss over capital", () => {
    expect(capBreach(600, 30, params())).toBe("daily_loss");
    expect(capBreach(600, 0, params())).toBe("capital");
    expect(capBreach(100, 0, params())).toBeNull();
  });
});
