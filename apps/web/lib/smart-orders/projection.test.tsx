import { describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { computePayoff, payoffInputFromDoc, HYPOTHETICAL_STAKE_USD } from "./projection";
import { emptyDoc } from "./doc";
import type { MarketFreshness } from "./queries";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };

const freshness = (over: Partial<MarketFreshness>): MarketFreshness => ({
  tokenId: "tok-1",
  hasData: true,
  dataAgeMs: 100,
  bestBid: 0.55,
  bestAsk: 0.57,
  ...over,
});

describe("computePayoff", () => {
  it("computes BUY payoff (size is shares, cost = price·size)", () => {
    const p = computePayoff({
      side: "BUY",
      price: 0.57,
      size: 100,
      tokenId: "tok-1",
      outcome: "YES",
      currentPrice: 0.6,
      hypothetical: false,
    });
    expect(p.costUsd).toBeCloseTo(57);
    expect(p.shares).toBe(100);
    expect(p.payoffIfWinUsd).toBeCloseTo(43); // 100·(1−0.57)
    expect(p.payoffIfLoseUsd).toBeCloseTo(-57); // −0.57·100
    expect(p.breakevenPrice).toBeCloseTo(0.57);
    expect(p.markToMarketUsd).toBeCloseTo(3); // (0.60−0.57)·100
  });

  it("computes SELL payoff (collateral (1−price)·size; wins when token → $0)", () => {
    const p = computePayoff({
      side: "SELL",
      price: 0.57,
      size: 100,
      tokenId: "tok-1",
      outcome: "YES",
      currentPrice: null,
      hypothetical: false,
    });
    expect(p.costUsd).toBeCloseTo(43);
    expect(p.payoffIfWinUsd).toBeCloseTo(-43); // token resolves $1 → seller loses
    expect(p.payoffIfLoseUsd).toBeCloseTo(57);
    expect(p.markToMarketUsd).toBeNull();
  });

  it("builds a monotonic exit-value curve crossing zero at the entry price", () => {
    const p = computePayoff({
      side: "BUY",
      price: 0.5,
      size: 10,
      tokenId: "tok-1",
      outcome: "YES",
      currentPrice: null,
      hypothetical: false,
    });
    expect(p.curve.length).toBeGreaterThan(30);
    expect(p.curve[0]!.v).toBeLessThan(0);
    expect(p.curve[p.curve.length - 1]!.v).toBeGreaterThan(0);
    const nearEntry = p.curve.find((pt) => Math.abs(pt.t - 0.51) < 0.001)!;
    expect(Math.abs(nearEntry.v)).toBeLessThan(0.2);
  });

  it("flags hypothetical stakes in the notes", () => {
    const p = computePayoff({
      side: "BUY",
      price: 0.4,
      size: 250,
      tokenId: "tok-1",
      outcome: "YES",
      currentPrice: null,
      hypothetical: true,
    });
    expect(p.notes.join(" ")).toContain("$100");
  });
});

describe("payoffInputFromDoc", () => {
  it("uses the order action directly", () => {
    const doc = emptyDoc();
    doc.action = {
      kind: "order",
      market,
      side: "BUY",
      price: 0.57,
      size: 100,
      orderType: "GTC",
      execution: "prepare",
    };
    const input = payoffInputFromDoc(doc, [freshness({})]);
    expect(input).not.toBeNull();
    expect(input!.hypothetical).toBe(false);
    expect(input!.price).toBeCloseTo(0.57);
    expect(input!.size).toBe(100);
    expect(input!.currentPrice).toBeCloseTo(0.56); // mid of 0.55/0.57
  });

  it("falls back to a hypothetical $100 buy at the first price threshold for alerts", () => {
    const doc = emptyDoc();
    doc.expr = {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: {
            kind: "price",
            market,
            source: "ask",
            comparator: "lte",
            threshold: 0.4,
          },
        },
      ],
    };
    const input = payoffInputFromDoc(doc, []);
    expect(input).not.toBeNull();
    expect(input!.hypothetical).toBe(true);
    expect(input!.side).toBe("BUY");
    expect(input!.price).toBeCloseTo(0.4);
    expect(input!.size).toBeCloseTo(HYPOTHETICAL_STAKE_USD / 0.4);
    expect(input!.currentPrice).toBeNull();
  });

  it("returns null when nothing is projectable (no order, no bound price condition)", () => {
    const doc = emptyDoc();
    expect(payoffInputFromDoc(doc, [])).toBeNull();
  });

  it("returns null for an order with a nonsensical price", () => {
    const doc = emptyDoc();
    doc.action = {
      kind: "order",
      market,
      side: "BUY",
      price: 0,
      size: 100,
      orderType: "GTC",
      execution: "prepare",
    };
    expect(payoffInputFromDoc(doc, [])).toBeNull();
  });
});
