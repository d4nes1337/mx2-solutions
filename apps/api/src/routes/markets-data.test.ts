import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { ok, err } from "@mx2/core";
import { validateStrategyDefinition } from "@mx2/rules";
import type {
  ClobClient,
  DataClient,
  GammaClient,
  GammaMarket,
  PolymarketError,
  PricePoint,
} from "@mx2/polymarket-client";
import type { MarketSnapshotStore } from "@mx2/db";
import { registerMarketsRoutes } from "./markets.js";
import { resetScenarioCache } from "../lib/scenarios.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const DIP_TOKEN = "111000111";
const FLAT_TOKEN = "222000222";
const HOUR = 3_600;
const T0 = 1_750_000_000; // unix seconds

/** 0.50 → dip to 0.41 → recovers through 0.55 to 0.62. Dip AND breakout win. */
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

const marketFor = (id: string, conditionId: string, tokenId: string): GammaMarket =>
  ({
    id,
    question: "Will BTC hit $150k?",
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
    clobTokenIds: `["${tokenId}","999${tokenId}"]`,
  }) as GammaMarket;

const MARKETS: Record<string, GammaMarket> = {
  "m-dip": marketFor("m-dip", "cond-dip", DIP_TOKEN),
  "m-flat": marketFor("m-flat", "cond-flat", FLAT_TOKEN),
};

const buildHarness = (dataOverrides: Partial<DataClient> = {}) => {
  const counters = { history: 0, trades: 0, holders: 0 };

  const gamma = {
    listEvents: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async (id: string) => {
      const m = MARKETS[id];
      return m ? ok(m) : err({ ...upstreamErr, statusCode: 404 });
    },
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
  } satisfies GammaClient;

  const clob = {
    getOrderbook: async () => err(upstreamErr),
    getTrades: async () => err(upstreamErr),
    getPrices: async () => err(upstreamErr),
    getLastTradePrice: async () => err(upstreamErr),
    getPricesHistory: async (params: { tokenId: string }) => {
      counters.history++;
      if (params.tokenId === DIP_TOKEN) return ok(dipSeries);
      if (params.tokenId === FLAT_TOKEN) return ok(flatSeries);
      return err(upstreamErr);
    },
    getClobMarket: async () => err(upstreamErr),
    getFeeRate: async () => err(upstreamErr),
    getRewardsMarket: async () => err(upstreamErr),
    getRewardsMarketsCurrent: async () => err(upstreamErr),
  } satisfies ClobClient;

  const data: DataClient = {
    getPositions: async () => ok([]),
    getClosedPositions: async () => ok([]),
    getActivity: async () => ok([]),
    getPositionValue: async () => ok(null),
    getLeaderboardEntry: async () => ok(null),
    getMarketTrades: async () => {
      counters.trades++;
      return ok([
        {
          proxyWallet: "0xwhale",
          side: "BUY",
          size: 250,
          price: 0.42,
          timestamp: T0,
          outcome: "Yes",
          outcomeIndex: 0,
          name: "trader-1",
          transactionHash: "0xtx",
        },
      ]);
    },
    getHolders: async () => {
      counters.holders++;
      return ok([
        {
          token: DIP_TOKEN,
          holders: [
            { proxyWallet: "0xwhale", amount: 15000.5, outcomeIndex: 0, name: "whale-1" },
            { proxyWallet: "0xshrimp", amount: 10, outcomeIndex: 0, pseudonym: "Fuzzy-Marmot" },
          ],
        },
      ]);
    },
    ...dataOverrides,
  };

  const snapshots: MarketSnapshotStore = {
    upsert: async () => {
      throw new Error("not implemented in test");
    },
    findByTokenId: async () => null,
    markStale: async () => {},
  };

  const app = Fastify({ logger: false });
  registerMarketsRoutes(app, {
    gammaClient: gamma,
    clobClient: clob,
    dataClient: data,
    marketSnapshots: snapshots,
  });
  return { app, counters };
};

beforeEach(() => {
  resetScenarioCache();
  resetRateLimits();
});

describe("GET /api/markets/:id/scenarios", () => {
  it("emits ranked entry scenarios with VALID prepare/once definitions and chat prompts", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/markets/m-dip/scenarios" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conditionId).toBe("cond-dip");
    expect(body.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(body.scenarios.length).toBeLessThanOrEqual(3);

    const kinds = body.scenarios.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain("dip_buy");
    expect(kinds).toContain("breakout");

    for (const sc of body.scenarios) {
      expect(validateStrategyDefinition(sc.definition)).toEqual([]);
      expect(sc.definition.recurrence.kind).toBe("once");
      expect(sc.definition.action.execution).toBe("prepare");
      expect(sc.definition.templateId).toBe("scenario");
      expect(typeof sc.prompt).toBe("string");
      expect(sc.prompt.length).toBeGreaterThan(10);
      expect(sc.entryPriceCents).toBeGreaterThan(0);
    }

    // Backtested winners come first; each claims a positive hypothetical PnL.
    const withPnl = body.scenarios.filter(
      (s: { stats: { hypotheticalPnlUsd?: number } }) => s.stats.hypotheticalPnlUsd !== undefined,
    );
    for (const sc of withPnl) expect(sc.stats.hypotheticalPnlUsd).toBeGreaterThan(0);

    const limit = body.scenarios.find((s: { kind: string }) => s.kind === "limit_entry");
    if (limit) {
      expect(limit.stats.touches).toBeGreaterThanOrEqual(1);
      expect(limit.stats.hypotheticalPnlUsd).toBeUndefined();
    }
    await app.close();
  });

  it("returns an empty list for a market with no winning entries", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/markets/m-flat/scenarios" });
    expect(res.statusCode).toBe(200);
    expect(res.json().scenarios).toEqual([]);
    await app.close();
  });

  it("serves the per-market cache on repeat calls", async () => {
    const { app, counters } = buildHarness();
    await app.inject({ method: "GET", url: "/api/markets/m-dip/scenarios" });
    const afterFirst = counters.history;
    const res2 = await app.inject({ method: "GET", url: "/api/markets/m-dip/scenarios" });
    expect(res2.statusCode).toBe(200);
    expect(counters.history).toBe(afterFirst);
    await app.close();
  });

  it("404s for an unknown market", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/markets/nope/scenarios" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /api/markets/:id/trades", () => {
  it("returns trimmed recent trades", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/markets/m-dip/trades" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conditionId).toBe("cond-dip");
    expect(body.trades).toEqual([
      {
        side: "BUY",
        price: 0.42,
        size: 250,
        timestamp: T0,
        outcome: "Yes",
        outcomeIndex: 0,
        name: "trader-1",
        proxyWallet: "0xwhale",
        transactionHash: "0xtx",
      },
    ]);
    await app.close();
  });

  it("502s with a typed error when upstream fails", async () => {
    const { app } = buildHarness({ getMarketTrades: async () => err(upstreamErr) });
    const res = await app.inject({ method: "GET", url: "/api/markets/m-dip/trades" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("UPSTREAM_ERROR");
    await app.close();
  });
});

describe("GET /api/markets/:id/holders", () => {
  it("labels holder groups with the matching outcome", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ method: "GET", url: "/api/markets/m-dip/holders" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups.length).toBe(1);
    expect(body.groups[0].outcome).toBe("Yes");
    expect(body.groups[0].holders[0]).toEqual({
      proxyWallet: "0xwhale",
      name: "whale-1",
      amount: 15000.5,
      profileImage: null,
    });
    // pseudonym is used when no display name exists
    expect(body.groups[0].holders[1].name).toBe("Fuzzy-Marmot");
    await app.close();
  });

  it("502s when upstream fails", async () => {
    const { app } = buildHarness({ getHolders: async () => err(upstreamErr) });
    const res = await app.inject({ method: "GET", url: "/api/markets/m-dip/holders" });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
