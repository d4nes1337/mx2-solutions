import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { ok, err } from "@mx2/core";
import type { ClobClient, DataClient, GammaClient, PolymarketError } from "@mx2/polymarket-client";
import type { MarketSnapshotRow, MarketSnapshotStore } from "@mx2/db";
import { registerMarketsRoutes } from "./markets.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const TOKEN = "123456789";
const BIDS = [{ price: "0.48", size: "100" }];
const ASKS = [{ price: "0.52", size: "80" }];

const snapshotFor = (isStale: boolean): MarketSnapshotRow =>
  ({
    tokenId: TOKEN,
    bids: BIDS,
    asks: ASKS,
    isStale,
    source: "ws",
    receivedAt: new Date(),
  }) as unknown as MarketSnapshotRow;

const buildHarness = (opts: { snapshot?: MarketSnapshotRow | null; restBook?: "ok" | "err" }) => {
  const gamma = {
    listEvents: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err({ ...upstreamErr, statusCode: 404 }),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
  } satisfies GammaClient;

  const clob = {
    getOrderbook: async () =>
      opts.restBook === "ok"
        ? ok({ market: "cond-1", asset_id: TOKEN, bids: BIDS, asks: ASKS })
        : err(upstreamErr),
    getTrades: async () => err(upstreamErr),
    getPrices: async () => err(upstreamErr),
    getLastTradePrice: async () => err(upstreamErr),
    getPricesHistory: async () => err(upstreamErr),
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
    getMarketTrades: async () => ok([]),
    getHolders: async () => ok([]),
  };

  const snapshots: MarketSnapshotStore = {
    upsert: async () => {
      throw new Error("not implemented in test");
    },
    findByTokenId: async () => opts.snapshot ?? null,
    markStale: async () => {},
  };

  const app = Fastify({ logger: false });
  registerMarketsRoutes(app, {
    gammaClient: gamma,
    clobClient: clob,
    dataClient: data,
    marketSnapshots: snapshots,
  });
  return app;
};

beforeEach(() => {
  resetRateLimits();
});

describe("GET /api/markets/orderbook (token-keyed)", () => {
  it("serves a fresh WS snapshot without touching CLOB REST", async () => {
    const app = buildHarness({ snapshot: snapshotFor(false), restBook: "err" });
    const res = await app.inject({ method: "GET", url: `/api/markets/orderbook?tokenId=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenId: TOKEN, bids: BIDS, asks: ASKS, isStale: false });
    expect(body.source).toBe("ws");
    await app.close();
  });

  it("falls back to CLOB REST when there is no snapshot", async () => {
    const app = buildHarness({ snapshot: null, restBook: "ok" });
    const res = await app.inject({ method: "GET", url: `/api/markets/orderbook?tokenId=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenId: TOKEN, bids: BIDS, asks: ASKS, isStale: false });
    expect(body.source).toBe("rest");
    await app.close();
  });

  it("surfaces a stale snapshot with the flag set when REST also fails", async () => {
    const app = buildHarness({ snapshot: snapshotFor(true), restBook: "err" });
    const res = await app.inject({ method: "GET", url: `/api/markets/orderbook?tokenId=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenId: TOKEN, isStale: true });
    await app.close();
  });

  it("502s when neither a snapshot nor REST is available", async () => {
    const app = buildHarness({ snapshot: null, restBook: "err" });
    const res = await app.inject({ method: "GET", url: `/api/markets/orderbook?tokenId=${TOKEN}` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("400s on a missing or malformed tokenId", async () => {
    const app = buildHarness({ snapshot: null, restBook: "ok" });
    for (const url of [
      "/api/markets/orderbook",
      "/api/markets/orderbook?tokenId=0xdeadbeef",
      "/api/markets/orderbook?tokenId=",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("is rate-limited per IP", async () => {
    const app = buildHarness({ snapshot: snapshotFor(false), restBook: "err" });
    let limited = false;
    for (let i = 0; i < 130; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/markets/orderbook?tokenId=${TOKEN}`,
      });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    await app.close();
  });
});
