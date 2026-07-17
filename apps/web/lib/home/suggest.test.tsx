import { describe, expect, it } from "vitest";
import type { GammaEvent, GammaMarket } from "../types";
import { HIGH_VOLUME_24H_USD, suggestStrategyFor } from "./suggest";

const makeMarket = (over: Partial<GammaMarket> = {}): GammaMarket => ({
  id: "m1",
  question: "Will it happen?",
  description: "",
  conditionId: "0xc1",
  slug: "will-it-happen",
  image: "",
  icon: "",
  active: true,
  closed: false,
  liquidity: "10000",
  volume: "50000",
  lastTradePrice: "0.5",
  bestBid: "0.49",
  bestAsk: "0.51",
  spread: "0.02",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  clobTokenIds: '["t1","t2"]',
  ...over,
});

const makeEvent = (markets: GammaMarket[], over: Partial<GammaEvent> = {}): GammaEvent => ({
  id: "e1",
  ticker: "EV",
  slug: "ev",
  title: "Event title",
  description: "",
  image: "",
  icon: "",
  active: true,
  closed: false,
  markets,
  ...over,
});

const midMarket = (bid: number, ask: number): GammaMarket =>
  makeMarket({ bestBid: String(bid), bestAsk: String(ask) });

describe("suggestStrategyFor", () => {
  it("suggests a dip-buy 5¢ under mid for competitive markets (0.35-0.65)", () => {
    const s = suggestStrategyFor(makeEvent([midMarket(0.49, 0.51)]));
    expect(s?.label).toBe("Dip-buy below 45¢");
    expect(s?.prompt).toContain("dips below 45¢");
    expect(s?.prompt).toContain('"Will it happen?"');
  });

  it("suggests a trailing stop for strong favorites (mid > 0.75)", () => {
    const s = suggestStrategyFor(makeEvent([midMarket(0.79, 0.81)]));
    expect(s?.label).toBe("Trailing-stop protect");
    expect(s?.prompt).toContain("drops 8 cents from its peak");
  });

  it("suggests a momentum alert for high 24h volume outside those bands", () => {
    const s = suggestStrategyFor(
      makeEvent([midMarket(0.69, 0.71)], { volume24hr: HIGH_VOLUME_24H_USD }),
    );
    expect(s?.label).toBe("Momentum alert");
    expect(s?.prompt).toContain("spikes 5 cents within an hour");
  });

  it("mid band wins over volume", () => {
    const s = suggestStrategyFor(
      makeEvent([midMarket(0.49, 0.51)], { volume24hr: HIGH_VOLUME_24H_USD * 10 }),
    );
    expect(s?.label).toBe("Dip-buy below 45¢");
  });

  it("falls back to a threshold entry otherwise", () => {
    const s = suggestStrategyFor(makeEvent([midMarket(0.69, 0.71)], { volume24hr: 1000 }));
    expect(s?.label).toBe("Threshold entry above 73¢");
    expect(s?.prompt).toContain("holds above 73¢ for 2 hours");
  });

  it("returns null without a usable market", () => {
    expect(suggestStrategyFor(makeEvent([]))).toBeNull();
    expect(suggestStrategyFor(makeEvent([makeMarket({ closed: true })]))).toBeNull();
    // No book, no last trade, no outcome prices → mid 0 → unusable.
    expect(
      suggestStrategyFor(
        makeEvent([
          makeMarket({ bestBid: "0", bestAsk: "0", lastTradePrice: "0", outcomePrices: "[]" }),
        ]),
      ),
    ).toBeNull();
    // Near-resolved market (mid 99¢) is not automatable.
    expect(suggestStrategyFor(makeEvent([midMarket(0.985, 0.995)]))).toBeNull();
  });
});
