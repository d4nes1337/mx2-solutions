import { describe, it, expect, beforeEach } from "vitest";
import { ok, err } from "@mx2/core";
import type { ClobClient, GammaClient, PolymarketError } from "@mx2/polymarket-client";
import { buildMarketStats } from "./stats.js";
import { resetEconomicsCache } from "../lib/market-economics.js";
import { resetScenarioCache } from "../lib/scenarios.js";
import type { MarketSearchHit } from "../lib/market-search.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };
const logger = { warn: () => {} };

const hit = (over: Partial<MarketSearchHit> = {}): MarketSearchHit => ({
  eventId: "ev-1",
  marketId: "m-1",
  title: "Will BTC hit $150k in 2026?",
  eventTitle: "BTC markets",
  image: "",
  conditionId: "cond-btc",
  tokenIds: ["111", "222"],
  outcomes: ["Yes", "No"],
  outcomePrices: ["0.48", "0.52"],
  volume: "90000",
  liquidity: "5000",
  endDate: null,
  negRisk: false,
  rewardsMinSize: null,
  rewardsMaxSpread: null,
  groupItemTitle: "",
  bestBid: "0.47",
  bestAsk: "0.48",
  active: true,
  closed: false,
  sportsMarketType: null,
  seriesSlug: null,
  recurrence: null,
  startDate: null,
  ...over,
});

const clobStub = (over: Partial<ClobClient> = {}): ClobClient => ({
  getOrderbook: async () => err(upstreamErr),
  getTrades: async () => err(upstreamErr),
  getPrices: async () => err(upstreamErr),
  getLastTradePrice: async () => err(upstreamErr),
  getPricesHistory: async () => err(upstreamErr),
  getClobMarket: async () => err(upstreamErr),
  getFeeRate: async () => err(upstreamErr),
  getRewardsMarket: async () => err(upstreamErr),
  getRewardsMarketsCurrent: async () => err(upstreamErr),
  ...over,
});

const gammaStub = (): GammaClient => ({
  listEvents: async () => ok([]),
  listEventsPaginated: async () =>
    ok({ data: [], pagination: { hasMore: false, totalResults: 0 } }),
  getSeries: async () => ok([]),
  getEvent: async () => err(upstreamErr),
  listMarkets: async () => ok([]),
  getMarket: async () => err(upstreamErr),
  getPublicProfile: async () => ok(null),
  findMarket: async () => ok(null),
  searchMarkets: async () => ok([]),
});

beforeEach(() => {
  resetEconomicsCache();
  resetScenarioCache();
});

describe("buildMarketStats", () => {
  it("tolerates every upstream failing — book/activity from the hit survive", async () => {
    const stats = await buildMarketStats(
      { clobClient: clobStub(), gammaClient: gammaStub(), logger },
      hit(),
      0,
    );
    expect(stats.title).toContain("BTC");
    expect(stats.outcome).toBe("Yes");
    expect(stats.book).toEqual({ bestBid: 0.47, bestAsk: 0.48, spread: 0.01 });
    expect(stats.activity).toEqual({ volumeUsd: 90000, liquidityUsd: 5000, endDate: null });
    expect(stats.price).toBeNull(); // history upstream down
    expect(stats.scenarios).toBeNull(); // scenarios need history
    // Economics resolves (all sources null → "unknown", never invented zeros).
    expect(stats.economics).toEqual({ feeSchedule: null, rewards: null });
  });

  it("computes range, typical movement and 24h drift from CLOB history (t in seconds)", async () => {
    const base = 1_700_000_000; // seconds
    const clob = clobStub({
      getPricesHistory: async () =>
        ok([
          { t: base, p: 0.4 },
          { t: base + 43_200, p: 0.5 },
          { t: base + 86_400, p: 0.45 },
        ]),
    });
    const stats = await buildMarketStats(
      { clobClient: clob, gammaClient: gammaStub(), logger },
      hit({ tokenIds: ["333", "444"], conditionId: "cond-drift" }),
      0,
    );
    expect(stats.price).toEqual({
      current: 0.48,
      high7d: 0.5,
      low7d: 0.4,
      // mean |Δp| = (0.1 + 0.05) / 2
      typicalMove: 0.075,
      // vs the newest sample at/before last − 24h → the first point
      drift24h: 0.05,
    });
    // With real history the scenario engine runs for real — array, not null.
    expect(Array.isArray(stats.scenarios)).toBe(true);
  });
});
