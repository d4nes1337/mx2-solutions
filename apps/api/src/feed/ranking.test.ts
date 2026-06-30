import { describe, expect, it } from "vitest";
import type { GammaEvent, GammaMarket } from "@mx2/polymarket-client";
import { buildHomeFeeds, rankFeed, type FeedTuning } from "./ranking.js";

const NOW = Date.parse("2026-06-30T12:00:00.000Z");

const tuning: FeedTuning = {
  limit: 5,
  minLiquidity: 2_000,
  minVolume24h: 1_000,
  newbornHours: 0.5,
  newbornMinLiquidity: 10_000,
  newbornMinVolume24h: 2_000,
  minResolveHours: 2,
  maxResolveDays: 365,
  longHorizonMaxResolveDays: 920,
  longHorizonMinLiquidity: 500_000,
  longHorizonMinVolume1wk: 250_000,
  minProbability: 0.03,
  maxProbability: 0.97,
  maxSpread: 0.1,
  goodSpread: 0.03,
  maxPerPrimaryTag: 6,
};

const market = (overrides: Partial<GammaMarket> = {}): GammaMarket =>
  ({
    id: "m1",
    question: "Will X happen?",
    description: "",
    conditionId: "0xabc",
    slug: "will-x",
    image: "",
    icon: "",
    active: true,
    closed: false,
    archived: false,
    restricted: false,
    acceptingOrders: true,
    liquidity: "10000",
    volume: "50000",
    lastTradePrice: "0.5",
    bestBid: "0.49",
    bestAsk: "0.51",
    spread: "0.02",
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.5","0.5"]',
    clobTokenIds: '["yes","no"]',
    endDate: "2026-07-03T12:00:00.000Z",
    createdAt: "2026-06-29T12:00:00.000Z",
    competitive: 0.9,
    ...overrides,
  }) as GammaMarket;

const event = (overrides: Partial<GammaEvent> = {}): GammaEvent =>
  ({
    id: "e1",
    ticker: "E1",
    slug: "event-1",
    title: "Event 1",
    description: "",
    image: "",
    icon: "",
    active: true,
    closed: false,
    archived: false,
    restricted: false,
    createdAt: "2026-06-29T12:00:00.000Z",
    creationDate: "2026-06-29T12:00:00.000Z",
    endDate: "2026-07-03T12:00:00.000Z",
    volume24hr: 5_000,
    volume1wk: 50_000,
    liquidity: 10_000,
    tags: [{ id: "1", label: "Crypto", slug: "crypto" }],
    markets: [market()],
    ...overrides,
  }) as GammaEvent;

describe("feed ranking", () => {
  it("rejects 99/1-style markets even when they have large volume", () => {
    const extreme = event({
      id: "extreme",
      markets: [
        market({
          id: "extreme-market",
          bestBid: "0.001",
          bestAsk: "0.002",
          spread: "0.001",
          liquidity: "100000",
        }),
      ],
    });

    const ranked = rankFeed([extreme], "top", tuning, NOW);

    expect(ranked.events).toHaveLength(0);
    expect(ranked.rejectedCount).toBe(1);
  });

  it("selects the best non-extreme market inside a multi-market event", () => {
    const multi = event({
      id: "multi",
      markets: [
        market({
          id: "tail",
          question: "Long-shot tail?",
          bestBid: "0.001",
          bestAsk: "0.002",
          spread: "0.001",
          liquidity: "500000",
        }),
        market({
          id: "balanced",
          question: "Balanced main market?",
          bestBid: "0.42",
          bestAsk: "0.44",
          spread: "0.02",
          liquidity: "20000",
        }),
      ],
    });

    const ranked = rankFeed([multi], "top", tuning, NOW);

    expect(ranked.events[0]?._feed.selectedMarketId).toBe("balanced");
    expect(ranked.events[0]?.markets[0]?.id).toBe("balanced");
  });

  it("filters out nearly ended and newborn illiquid markets", () => {
    const nearlyEnded = event({
      id: "nearly-ended",
      markets: [market({ id: "ending", endDate: "2026-06-30T12:30:00.000Z" })],
    });
    const newbornJunk = event({
      id: "newborn",
      createdAt: "2026-06-30T11:45:00.000Z",
      volume24hr: 50,
      liquidity: 100,
      markets: [
        market({
          id: "newborn-market",
          createdAt: "2026-06-30T11:45:00.000Z",
          liquidity: "100",
          volume: "50",
        }),
      ],
    });

    const ranked = rankFeed([nearlyEnded, newbornJunk], "now", tuning, NOW);

    expect(ranked.events).toHaveLength(0);
    expect(ranked.rejectedCount).toBe(2);
  });

  it("ranks urgent, active markets above far-away markets in Now", () => {
    const urgent = event({
      id: "urgent",
      volume24hr: 8_000,
      markets: [market({ id: "urgent-market", endDate: "2026-07-01T12:00:00.000Z" })],
    });
    const far = event({
      id: "far",
      volume24hr: 8_000,
      markets: [market({ id: "far-market", endDate: "2026-12-31T12:00:00.000Z" })],
    });

    const ranked = rankFeed([far, urgent], "now", tuning, NOW);

    expect(ranked.events[0]?.id).toBe("urgent");
    expect(ranked.events[0]?._feed.reasons).toContain("soon");
  });

  it("dedupes events across the home screen columns", () => {
    const events = [
      event({ id: "a", volume24hr: 20_000, markets: [market({ id: "a-market" })] }),
      event({
        id: "b",
        volume24hr: 15_000,
        markets: [market({ id: "b-market", endDate: "2026-07-04T12:00:00.000Z" })],
      }),
      event({
        id: "c",
        volume24hr: 10_000,
        markets: [market({ id: "c-market", endDate: "2026-07-05T12:00:00.000Z" })],
      }),
    ];

    const feeds = buildHomeFeeds(events, tuning, NOW);
    const nowIds = new Set(feeds.now.events.map((e) => e.id));
    const topIds = new Set(feeds.top.events.map((e) => e.id));

    expect([...nowIds].some((id) => topIds.has(id))).toBe(false);
  });
});
