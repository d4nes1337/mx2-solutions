import { describe, expect, it } from "vitest";
import type { GammaEvent, GammaMarket } from "./types";
import {
  hottestScore,
  newVolumeScore,
  noTopOfBook,
  primaryMarket,
  resolveUrgency,
  sortEventsByScore,
  yesTopOfBook,
} from "./feeds";

const market = (overrides: Partial<GammaMarket> = {}): GammaMarket => ({
  id: "m1",
  question: "Will X?",
  description: "",
  conditionId: "0xabc",
  slug: "x",
  image: "",
  icon: "",
  active: true,
  closed: false,
  liquidity: "10000",
  volume: "50000",
  lastTradePrice: "0.5",
  bestBid: "0.48",
  bestAsk: "0.52",
  spread: "0.04",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  clobTokenIds: "[]",
  endDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  ...overrides,
});

const event = (overrides: Partial<GammaEvent> = {}): GammaEvent => ({
  id: "e1",
  ticker: "t",
  slug: "s",
  title: "Event",
  description: "",
  image: "",
  icon: "",
  active: true,
  closed: false,
  volume1wk: 1000,
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  markets: [market()],
  ...overrides,
});

describe("primaryMarket", () => {
  it("picks the most liquid open market", () => {
    const e = event({
      markets: [
        market({ id: "a", liquidity: "100", closed: false }),
        market({ id: "b", liquidity: "900", closed: false }),
      ],
    });
    expect(primaryMarket(e)?.id).toBe("b");
  });
});

describe("yesTopOfBook / noTopOfBook", () => {
  it("derives NO quotes as complements of YES", () => {
    const m = market({ bestBid: "0.4", bestAsk: "0.6" });
    expect(yesTopOfBook(m)).toEqual({ bid: 0.4, ask: 0.6 });
    expect(noTopOfBook(m)).toEqual({ bid: 0.4, ask: 0.6 });
  });
});

describe("resolveUrgency", () => {
  it("is higher when resolve date is sooner", () => {
    const soon = Date.now() + 3 * 86_400_000;
    const later = Date.now() + 60 * 86_400_000;
    expect(resolveUrgency(soon)).toBeGreaterThan(resolveUrgency(later));
  });
});

describe("feed scoring", () => {
  it("ranks hotter events with volume and near resolve higher", () => {
    const hot = event({
      volume1wk: 5000,
      markets: [market({ endDate: new Date(Date.now() + 2 * 86_400_000).toISOString() })],
    });
    const cold = event({
      volume1wk: 5000,
      markets: [market({ endDate: new Date(Date.now() + 120 * 86_400_000).toISOString() })],
    });
    expect(hottestScore(hot)).toBeGreaterThan(hottestScore(cold));
  });

  it("ranks newer events higher in newVolumeScore", () => {
    const newer = event({
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      volume1wk: 1000,
    });
    const older = event({
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      volume1wk: 1000,
    });
    expect(newVolumeScore(newer)).toBeGreaterThan(newVolumeScore(older));
  });

  it("sortEventsByScore returns at most FEED_LIMIT items", () => {
    const events = Array.from({ length: 30 }, (_, i) => event({ id: String(i), volume1wk: i }));
    const sorted = sortEventsByScore(events, hottestScore);
    expect(sorted.length).toBe(20);
    expect(sorted[0]?.id).toBe("29");
  });
});
