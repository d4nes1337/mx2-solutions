import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { ok, err } from "@mx2/core";
import type {
  GammaClient,
  GammaRelatedTag,
  GammaTag,
  ListEventsPaginatedParams,
  PolymarketError,
} from "@mx2/polymarket-client";
import { registerBrowseRoutes } from "./browse.js";
import { resetCategoryFiltersCache, type CategoryFilters } from "../lib/category-filters.js";
import { resetRateLimits } from "../middleware/rate-limit.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "boom", statusCode: 502 };

/**
 * Mirrors the live shape verified 2026-07-29: geopolitics ranks Iran, Ukraine
 * and Thailand-Cambodia, but Thailand-Cambodia has zero open events and so is
 * the one polymarket.com drops from the row.
 */
const TAGS: Record<number, GammaTag> = {
  78: { id: "78", label: "Iran", slug: "iran" },
  101: { id: "101", label: "Ukraine", slug: "ukraine" },
  102: { id: "102", label: "Thailand-Cambodia", slug: "thailand-cambodia" },
};

const COUNTS: Record<string, number> = {
  geopolitics: 380,
  iran: 106,
  ukraine: 56,
  "thailand-cambodia": 0,
};

const buildHarness = (opts?: { relatedFail?: boolean; unknownTagId?: boolean }) => {
  const state = { fail: false };
  const counted: string[] = [];
  const tagLookups: number[] = [];

  const related: GammaRelatedTag[] = [
    // Deliberately out of rank order — the route must sort by rank.
    { tagID: 100265, relatedTagID: 101, rank: 2 },
    { tagID: 100265, relatedTagID: 78, rank: 1 },
    { tagID: 100265, relatedTagID: 102, rank: 3 },
  ];

  const gamma = {
    listEvents: async () => ok([]),
    listEventsPaginated: async (params?: ListEventsPaginatedParams) => {
      if (state.fail) return err(upstreamErr);
      const slug = params?.tag_slug ?? "";
      counted.push(slug);
      return ok({
        data: [],
        pagination: { hasMore: false, totalResults: COUNTS[slug] ?? 0 },
      });
    },
    getSeries: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
    getTag: async (id: number | string) => {
      if (state.fail) return err(upstreamErr);
      tagLookups.push(Number(id));
      if (opts?.unknownTagId) return ok(null);
      return ok(TAGS[Number(id)] ?? null);
    },
    listRelatedTags: async () => {
      if (state.fail || opts?.relatedFail) return err(upstreamErr);
      return ok(related);
    },
  } satisfies GammaClient;

  const app = Fastify({ logger: false });
  registerBrowseRoutes(app, { gammaClient: gamma });
  return { app, state, counted, tagLookups };
};

beforeEach(() => {
  resetCategoryFiltersCache();
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/markets/categories/:slug/filters", () => {
  it("returns rank-ordered sub-filters with counts and drops empty ones", async () => {
    const { app } = buildHarness();
    const res = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as CategoryFilters;
    expect(body.slug).toBe("geopolitics");
    expect(body.totalCount).toBe(380);
    expect(body.degraded).toBe(false);
    // rank 1 then rank 2; rank 3 (thailand-cambodia, 0 events) is cut.
    expect(body.filters).toEqual([
      { label: "Iran", slug: "iran", count: 106 },
      { label: "Ukraine", slug: "ukraine", count: 56 },
    ]);
  });

  it("rejects a malformed slug without calling upstream", async () => {
    const { app, tagLookups } = buildHarness();
    const res = await app.inject({ url: "/api/markets/categories/Not%20A%20Slug/filters" });
    expect(res.statusCode).toBe(400);
    expect(tagLookups).toHaveLength(0);
  });

  it("returns an empty row when a tag id no longer resolves", async () => {
    const { app } = buildHarness({ unknownTagId: true });
    const res = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CategoryFilters).filters).toEqual([]);
  });

  it("fails closed with 502 when the related-tags lookup fails", async () => {
    const { app } = buildHarness({ relatedFail: true });
    const res = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(res.statusCode).toBe(502);
  });

  it("serves repeat requests from cache", async () => {
    const { app, tagLookups } = buildHarness();
    await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    const first = tagLookups.length;
    expect(first).toBe(3);
    await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(tagLookups).toHaveLength(first);
  });

  it("serves the last good row marked degraded once fresh TTL passes and Gamma fails", async () => {
    vi.useFakeTimers();
    const { app, state } = buildHarness();
    const good = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect((good.json() as CategoryFilters).filters).toHaveLength(2);

    // Past the 10-minute fresh TTL but inside the 1-hour stale window.
    vi.advanceTimersByTime(11 * 60_000);
    state.fail = true;
    const stale = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(stale.statusCode).toBe(200);
    const body = stale.json() as CategoryFilters;
    expect(body.degraded).toBe(true);
    expect(body.filters).toHaveLength(2);

    // Past the stale window the failure surfaces.
    vi.advanceTimersByTime(60 * 60_000);
    const dead = await app.inject({ url: "/api/markets/categories/geopolitics/filters" });
    expect(dead.statusCode).toBe(502);
  });
});
