import { describe, expect, it } from "vitest";
import type { EnrichedOpenOrder, OrderLevel } from "@/lib/types";
import { queueProgress, queueSnapshot } from "./QueuePosition";

const bids: OrderLevel[] = [
  { price: "0.80", size: "100" },
  { price: "0.78", size: "500" },
  { price: "0.77", size: "300" },
];
const asks: OrderLevel[] = [
  { price: "0.82", size: "250" },
  { price: "0.85", size: "400" },
];

function order(over: Partial<EnrichedOpenOrder>): EnrichedOpenOrder {
  return {
    id: "o1",
    market: "m",
    asset_id: "t",
    side: "BUY",
    original_size: "200",
    size_matched: "0",
    price: "0.78",
    status: "LIVE",
    ...over,
  };
}

describe("queueSnapshot", () => {
  it("rests a BUY on the bid and computes size ahead", () => {
    const s = queueSnapshot(order({}), bids, asks);
    expect(s.remaining).toBe(200);
    expect(s.levelSize).toBe(500); // 0.78 bid
    expect(s.aheadNow).toBe(300); // 500 − 200 remaining
    expect(s.filling).toBe(false);
  });

  it("rests a SELL on the ask", () => {
    const s = queueSnapshot(
      order({ side: "SELL", price: "0.82", original_size: "50" }),
      bids,
      asks,
    );
    expect(s.levelSize).toBe(250);
    expect(s.aheadNow).toBe(200); // 250 − 50
  });

  it("marks filling and reduces remaining once matched", () => {
    const s = queueSnapshot(order({ size_matched: "120" }), bids, asks);
    expect(s.filling).toBe(true);
    expect(s.remaining).toBe(80);
    expect(s.aheadNow).toBe(420); // 500 − 80
  });

  it("returns zero ahead when the price is outside the visible book", () => {
    const s = queueSnapshot(order({ price: "0.50" }), bids, asks);
    expect(s.levelSize).toBe(0);
    expect(s.aheadNow).toBe(0);
  });
});

describe("queueProgress", () => {
  it("is full while filling", () => {
    expect(queueProgress(300, 300, true)).toBe(1);
  });

  it("advances as the running-min ahead shrinks", () => {
    expect(queueProgress(300, 300, false)).toBe(0);
    expect(queueProgress(150, 300, false)).toBeCloseTo(0.5);
    expect(queueProgress(0, 300, false)).toBe(1);
  });

  it("clamps and handles a zero start", () => {
    expect(queueProgress(0, 0, false)).toBe(1);
    expect(queueProgress(400, 300, false)).toBe(0);
  });
});
