import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { ok, err } from "@mx2/core";
import type {
  GammaClient,
  GammaEvent,
  ListEventsPaginatedParams,
  PolymarketError,
} from "@mx2/polymarket-client";
import { registerBrowseRoutes, resetBrowseCache } from "./browse.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "boom", statusCode: 502 };

const eventFor = (id: string, title: string): GammaEvent =>
  ({ id, title, slug: title.toLowerCase().replace(/\s+/g, "-") }) as GammaEvent;

const buildHarness = (opts?: { fail?: boolean; totalResults?: number }) => {
  const calls: ListEventsPaginatedParams[] = [];
  const state = { fail: opts?.fail ?? false };

  const gamma = {
    listEvents: async () => ok([]),
    listEventsPaginated: async (params?: ListEventsPaginatedParams) => {
      calls.push(params ?? {});
      if (state.fail) return err(upstreamErr);
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 20;
      return ok({
        data: Array.from({ length: limit }, (_, i) =>
          eventFor(`ev-${offset + i}`, `Event ${offset + i}`),
        ),
        pagination: { hasMore: offset + limit < 60, totalResults: opts?.totalResults ?? 60 },
      });
    },
    getSeries: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
    getTag: async () => ok(null),
    listRelatedTags: async () => ok([]),
  } satisfies GammaClient;

  const app = Fastify({ logger: false });
  registerBrowseRoutes(app, { gammaClient: gamma });
  return { app, calls, state };
};

beforeEach(() => {
  resetBrowseCache();
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/markets/browse", () => {
  it("passes Polymarket-homepage params through and returns the page envelope", async () => {
    const { app, calls } = buildHarness();
    const res = await app.inject({ url: "/api/markets/browse?limit=20&offset=20" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      events: GammaEvent[];
      hasMore: boolean;
      totalResults: number;
      offset: number;
      degraded: boolean;
    };
    expect(body.events).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.totalResults).toBe(60);
    expect(body.offset).toBe(20);
    expect(body.degraded).toBe(false);
    expect(calls[0]).toMatchObject({
      limit: 20,
      offset: 20,
      active: true,
      closed: false,
      archived: false,
      order: "volume24hr",
      ascending: false,
    });
    expect(calls[0]).not.toHaveProperty("tag_slug");
  });

  it("forwards tag as tag_slug and rejects malformed tags", async () => {
    const { app, calls } = buildHarness();
    const res = await app.inject({ url: "/api/markets/browse?tag=crypto" });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ tag_slug: "crypto" });

    const bad = await app.inject({ url: "/api/markets/browse?tag=Nope%20Tag" });
    expect(bad.statusCode).toBe(400);
  });

  it("accepts the mixed-case slugs Gamma really serves (EPL, Global-Rates)", async () => {
    const { app, calls } = buildHarness();
    // Rendered as sub-filter chips under Sports and Economy — rejecting them
    // would 400 a chip we ourselves put on screen.
    expect((await app.inject({ url: "/api/markets/browse?tag=EPL" })).statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ tag_slug: "EPL" });
    expect((await app.inject({ url: "/api/markets/browse?tag=Global-Rates" })).statusCode).toBe(
      200,
    );
  });

  it("rejects out-of-range limit and offset", async () => {
    const { app } = buildHarness();
    expect((await app.inject({ url: "/api/markets/browse?limit=51" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/markets/browse?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/markets/browse?offset=1001" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/markets/browse?offset=-1" })).statusCode).toBe(400);
  });

  it("serves repeat requests for the same page from cache", async () => {
    const { app, calls } = buildHarness();
    await app.inject({ url: "/api/markets/browse?offset=0" });
    await app.inject({ url: "/api/markets/browse?offset=0" });
    expect(calls).toHaveLength(1);
    // A different page key is a separate upstream fetch.
    await app.inject({ url: "/api/markets/browse?offset=20" });
    expect(calls).toHaveLength(2);
  });

  it("serves the last good page marked degraded once fresh TTL passes and Gamma fails", async () => {
    vi.useFakeTimers();
    const { app, state } = buildHarness();
    const first = await app.inject({ url: "/api/markets/browse?offset=0" });
    expect((first.json() as { degraded: boolean }).degraded).toBe(false);

    state.fail = true;
    vi.advanceTimersByTime(21_000); // past FRESH_TTL, inside STALE_TTL
    const degraded = await app.inject({ url: "/api/markets/browse?offset=0" });
    expect(degraded.statusCode).toBe(200);
    expect((degraded.json() as { degraded: boolean }).degraded).toBe(true);

    vi.advanceTimersByTime(5 * 60_000); // past STALE_TTL — stale copy expires
    const dead = await app.inject({ url: "/api/markets/browse?offset=0" });
    expect(dead.statusCode).toBe(502);
    expect((dead.json() as { error: string }).error).toBe("UPSTREAM_ERROR");
  });

  it("maps upstream 429 to 429 when no cache exists", async () => {
    const gamma429: PolymarketError = {
      code: "RATE_LIMIT",
      message: "slow down",
      statusCode: 429,
    };
    const app = Fastify({ logger: false });
    registerBrowseRoutes(app, {
      gammaClient: {
        listEvents: async () => ok([]),
        listEventsPaginated: async () => err(gamma429),
        getSeries: async () => ok([]),
        getEvent: async () => err(upstreamErr),
        listMarkets: async () => ok([]),
        getMarket: async () => err(upstreamErr),
        getPublicProfile: async () => ok(null),
        findMarket: async () => ok(null),
        searchMarkets: async () => ok([]),
        getTag: async () => ok(null),
        listRelatedTags: async () => ok([]),
      } satisfies GammaClient,
    });
    const res = await app.inject({ url: "/api/markets/browse" });
    expect(res.statusCode).toBe(429);
  });
});
