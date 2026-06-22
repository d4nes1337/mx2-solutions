import { describe, it, expect } from "vitest";
import { ok, err } from "@mx2/core";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { GammaClient, ClobClient, PolymarketError } from "@mx2/polymarket-client";
import { buildApp, type DbProbe } from "./app.js";

const config = loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" });
const logger = createLogger({ name: "api-test", level: "silent" });

const upstreamErr: PolymarketError = {
  code: "UPSTREAM_ERROR",
  message: "not found",
  statusCode: 404,
};

const mockGammaClient: GammaClient = {
  listEvents: async () => ok([]),
  getEvent: async () => err(upstreamErr),
  listMarkets: async () => ok([]),
  getMarket: async () => err(upstreamErr),
  getPricesHistory: async () => ok([]),
};

const mockClobClient: ClobClient = {
  getOrderbook: async () => err(upstreamErr),
  getTrades: async () => ok([]),
  getPrices: async () => ok([]),
  getLastTradePrice: async () => err(upstreamErr),
};

const mockMarketSnapshots: MarketSnapshotStore = {
  upsert: async () => {
    throw new Error("not implemented in test");
  },
  findByTokenId: async () => null,
  markStale: async () => {},
};

const appWith = (db: DbProbe) =>
  buildApp({
    config,
    logger,
    db,
    gammaClient: mockGammaClient,
    clobClient: mockClobClient,
    marketSnapshots: mockMarketSnapshots,
  });

describe("health endpoints", () => {
  it("GET /healthz returns ok regardless of downstreams", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", env: "development" });
    await app.close();
  });

  it("GET /readyz returns 200 when db is up", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", checks: { db: "up" } });
    await app.close();
  });

  it("GET /readyz returns 503 when db is down", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { db: "down" } });
    await app.close();
  });

  it("GET /api/feature-flags reports risk features off by default", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/feature-flags" });
    expect(res.json()).toMatchObject({
      liveTrading: false,
      conditionalLiveExecution: false,
      relayer: false,
    });
    await app.close();
  });
});

describe("events routes", () => {
  it("GET /api/events returns empty list from mock client", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ events: [], count: 0 });
    await app.close();
  });

  it("GET /api/events/:id returns 404 when upstream returns 404", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/events/unknown-id" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("markets routes", () => {
  it("GET /api/markets/:id returns 404 when upstream returns 404", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/markets/unknown-id" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
