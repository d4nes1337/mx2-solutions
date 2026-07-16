import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { ok, err } from "@mx2/core";
import { validateStrategyDefinition } from "@mx2/rules";
import type {
  ClobClient,
  GammaClient,
  GammaEvent,
  GammaMarket,
  PolymarketError,
  PricePoint,
} from "@mx2/polymarket-client";
import { registerShowcasesRoutes } from "./showcases.js";
import { resetShowcaseCache } from "../lib/showcases.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const DIP_TOKEN = "111000111";
const FLAT_TOKEN = "222000222";
const HOUR = 3_600;
const T0 = 1_750_000_000; // unix seconds

/** 0.50 → dip to 0.41 (3 hourly samples) → recovers to 0.62. Profitable. */
const dipSeries: PricePoint[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({ t: T0 + i * HOUR, p: 0.5 })),
  { t: T0 + 5 * HOUR, p: 0.41 },
  { t: T0 + 6 * HOUR, p: 0.41 },
  { t: T0 + 7 * HOUR, p: 0.42 },
  { t: T0 + 8 * HOUR, p: 0.55 },
  { t: T0 + 9 * HOUR, p: 0.62 },
];

const flatSeries: PricePoint[] = Array.from({ length: 10 }, (_, i) => ({
  t: T0 + i * HOUR,
  p: 0.5,
}));

const endDate = new Date(Date.now() + 30 * 86_400_000).toISOString();

const marketFor = (conditionId: string, tokenId: string, question: string): GammaMarket =>
  ({
    id: `m-${tokenId}`,
    question,
    description: "",
    conditionId,
    slug: "",
    image: "img.png",
    icon: "",
    active: true,
    closed: false,
    archived: false,
    restricted: false,
    new: false,
    featured: false,
    acceptingOrders: true,
    liquidity: "9000",
    volume: "50000",
    openInterest: "0",
    lastTradePrice: "0.5",
    bestBid: "0.49",
    bestAsk: "0.51",
    spread: "0.02",
    status: "open",
    endDate,
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.50","0.50"]',
    clobTokenIds: `["${tokenId}","${tokenId}-no"]`,
  }) as GammaMarket;

const eventFor = (id: string, title: string, market: GammaMarket): GammaEvent =>
  ({
    id,
    title,
    image: "event.png",
    endDate,
    markets: [market],
  }) as unknown as GammaEvent;

const buildHarness = () => {
  const counters = { listEvents: 0, history: 0 };
  const gamma = {
    listEvents: async () => {
      counters.listEvents++;
      return ok([
        eventFor("ev-1", "Will BTC hit $150k?", marketFor("cond-dip", DIP_TOKEN, "BTC 150k?")),
        eventFor("ev-2", "Flat market?", marketFor("cond-flat", FLAT_TOKEN, "Flat?")),
      ]);
    },
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
  } satisfies GammaClient;

  const clob = {
    getOrderbook: async () => err(upstreamErr),
    getTrades: async () => err(upstreamErr),
    getPrices: async () => err(upstreamErr),
    getLastTradePrice: async () => err(upstreamErr),
    getClobMarket: async () => err(upstreamErr),
    getFeeRate: async () => err(upstreamErr),
    getRewardsMarket: async () => err(upstreamErr),
    getRewardsMarketsCurrent: async () => err(upstreamErr),
    getPricesHistory: async (params: { tokenId: string }) => {
      counters.history++;
      if (params.tokenId === DIP_TOKEN) return ok(dipSeries);
      if (params.tokenId === FLAT_TOKEN) return ok(flatSeries);
      return err(upstreamErr);
    },
  } satisfies ClobClient;

  const app = Fastify({ logger: false });
  registerShowcasesRoutes(app, { gammaClient: gamma, clobClient: clob });
  return { app, counters };
};

beforeEach(() => {
  resetShowcaseCache();
  resetRateLimits();
});

describe("GET /api/showcases", () => {
  it("emits a profitable dip-buy showcase with a VALID once/prepare definition", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/showcases" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.showcases.length).toBeGreaterThanOrEqual(1);

    const sc = body.showcases[0];
    expect(sc.market.conditionId).toBe("cond-dip");
    expect(sc.market.tokenId).toBe(DIP_TOKEN);
    expect(sc.stats.hypotheticalPnlUsd).toBeGreaterThan(0);
    expect(sc.stats.stakeUsd).toBe(100);
    expect(sc.stats.triggerCount).toBeGreaterThanOrEqual(1);
    expect(sc.triggers.length).toBe(sc.stats.triggerCount);
    expect(sc.sentence).toContain("dips below");

    // The ready-to-open definition must pass the SAME validator arm-time uses.
    expect(validateStrategyDefinition(sc.definition)).toEqual([]);
    expect(sc.definition.recurrence.kind).toBe("once");
    expect(sc.definition.action.execution).toBe("prepare");
    expect(sc.definition.templateId).toBe("showcase");
    await app.close();
  });

  it("excludes markets whose backtest never wins", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/showcases" });
    const conditionIds = res
      .json()
      .showcases.map((s: { market: { conditionId: string } }) => s.market.conditionId);
    expect(conditionIds).not.toContain("cond-flat");
    await app.close();
  });

  it("serves the cache on repeat calls (no extra upstream hits)", async () => {
    const { app, counters } = buildHarness();
    await app.inject({ method: "GET", url: "/api/showcases" });
    const afterFirst = { ...counters };
    const res2 = await app.inject({ method: "GET", url: "/api/showcases" });
    expect(res2.statusCode).toBe(200);
    expect(counters.listEvents).toBe(afterFirst.listEvents);
    expect(counters.history).toBe(afterFirst.history);
    await app.close();
  });

  it("downsamples the embedded series", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/showcases" });
    for (const sc of res.json().showcases) {
      expect(sc.series.length).toBeLessThanOrEqual(81);
      expect(sc.series.length).toBeGreaterThan(1);
    }
    await app.close();
  });

  it("502s when upstream fails and there is no cache", async () => {
    const gamma = {
      listEvents: async () => err(upstreamErr),
      getEvent: async () => err(upstreamErr),
      listMarkets: async () => ok([]),
      getMarket: async () => err(upstreamErr),
      getPublicProfile: async () => ok(null),
      findMarket: async () => ok(null),
      searchMarkets: async () => ok([]),
    } satisfies GammaClient;
    const clob = {
      getOrderbook: async () => err(upstreamErr),
      getTrades: async () => err(upstreamErr),
      getPrices: async () => err(upstreamErr),
      getLastTradePrice: async () => err(upstreamErr),
      getPricesHistory: async () => err(upstreamErr),
      getClobMarket: async () => err(upstreamErr),
      getFeeRate: async () => err(upstreamErr),
      getRewardsMarket: async () => err(upstreamErr),
      getRewardsMarketsCurrent: async () => err(upstreamErr),
    } satisfies ClobClient;
    const app = Fastify({ logger: false });
    registerShowcasesRoutes(app, { gammaClient: gamma, clobClient: clob });
    const res = await app.inject({ method: "GET", url: "/api/showcases" });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
