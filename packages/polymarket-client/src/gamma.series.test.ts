import { describe, it, expect, beforeEach } from "vitest";
import { ok, err } from "@mx2/core";
import {
  cadenceMsFromSeriesSlug,
  listSeriesWindows,
  outcomeIndexOf,
  resetSeriesIdCache,
  resolveSeriesWindow,
  windowStartMsOf,
  type SeriesWindow,
} from "./gamma/series.js";
import { GammaEventSchema, type GammaSeries } from "./gamma/schema.js";
import type { GammaClient, ListEventsPaginatedParams } from "./gamma/client.js";
import type { PolymarketError } from "./errors.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const T0 = Date.parse("2026-07-27T13:21:00Z"); // 1:21pm — inside the 13:20 window
const MIN = 60_000;
const WINDOW_MS = 5 * MIN;
/** The 5m window that is live at T0: opens 13:20, closes 13:25. */
const LIVE_START = Math.floor(T0 / WINDOW_MS) * WINDOW_MS;

const windowEvent = (windowStartMs: number) => {
  const startSec = Math.floor(windowStartMs / 1000);
  return GammaEventSchema.parse({
    id: `ev-${startSec}`,
    slug: `btc-updown-5m-${startSec}`,
    title: `Bitcoin Up or Down — ${new Date(windowStartMs).toISOString()}`,
    endDate: new Date(windowStartMs + WINDOW_MS).toISOString(),
    // Gamma reports CREATION time here — hours before the window opens. The
    // resolver must ignore it and read the window start off the slug.
    startDate: new Date(windowStartMs - 10 * 3_600_000).toISOString(),
    seriesSlug: "btc-up-or-down-5m",
    markets: [
      {
        id: `m-${startSec}`,
        question: "Up or Down?",
        conditionId: `cond-${startSec}`,
        active: true,
        closed: false,
        liquidity: "18000",
        outcomes: '["Up","Down"]',
        outcomePrices: '["0.51","0.49"]',
        clobTokenIds: `["${startSec}-up","${startSec}-down"]`,
      },
    ],
  });
};

const buildGamma = (opts?: { windowFail?: boolean; unknownSeries?: boolean }) => {
  const calls: ListEventsPaginatedParams[] = [];
  let seriesLookups = 0;
  const gamma = {
    listEvents: async () => ok([]),
    listEventsPaginated: async (params?: ListEventsPaginatedParams) => {
      calls.push(params ?? {});
      if (opts?.windowFail) return err(upstreamErr);
      // Upstream returns soonest-ending first, including windows not yet open.
      return ok({
        data: [0, 1, 2, 3].map((i) => windowEvent(LIVE_START + i * WINDOW_MS)),
        pagination: { hasMore: true, totalResults: 280 },
      });
    },
    getSeries: async ({ slug }: { slug: string }) => {
      seriesLookups++;
      if (opts?.unknownSeries) return ok([] as GammaSeries[]);
      return ok([
        {
          id: "10684",
          slug,
          title: "BTC Up or Down 5m",
          recurrence: "5m",
          active: true,
          events: [],
        },
      ] as GammaSeries[]);
    },
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
    getTag: async () => ok(null),
    listRelatedTags: async () => ok([]),
  } satisfies GammaClient;
  return { gamma, calls, seriesLookups: () => seriesLookups };
};

beforeEach(() => resetSeriesIdCache());

describe("windowStartMsOf", () => {
  it("reads the window start off the slug's unix stamp", () => {
    expect(windowStartMsOf("btc-updown-5m-1785158400", 1785158700_000, 5 * MIN)).toBe(
      1785158400_000,
    );
  });

  it("falls back to endDate minus the cadence for an unrecognised slug", () => {
    const end = Date.parse("2026-07-27T13:25:00Z");
    expect(windowStartMsOf("some-new-shape", end, 5 * MIN)).toBe(end - 5 * MIN);
  });

  it("ignores a trailing number that cannot be a window stamp", () => {
    const end = Date.parse("2026-07-27T13:25:00Z");
    expect(windowStartMsOf("btc-updown-5m-42", end, 5 * MIN)).toBe(end - 5 * MIN);
  });
});

describe("cadenceMsFromSeriesSlug", () => {
  it("maps the known cadences", () => {
    expect(cadenceMsFromSeriesSlug("btc-up-or-down-5m")).toBe(5 * MIN);
    expect(cadenceMsFromSeriesSlug("eth-up-or-down-15m")).toBe(15 * MIN);
    expect(cadenceMsFromSeriesSlug("btc-up-or-down-hourly")).toBe(60 * MIN);
  });
});

describe("listSeriesWindows", () => {
  it("always sends end_date_min — without it Gamma returns dead instances", async () => {
    const { gamma, calls } = buildGamma();
    await listSeriesWindows(gamma, "btc-up-or-down-5m", T0);
    expect(calls[0]).toMatchObject({
      series_id: "10684",
      closed: false,
      end_date_min: new Date(T0).toISOString(),
      order: "endDate",
      ascending: true,
    });
    // `active` would exclude the pre-created future windows we depend on.
    expect(calls[0]).not.toHaveProperty("active");
  });

  it("caches the series id lookup across calls", async () => {
    const { gamma, seriesLookups } = buildGamma();
    await listSeriesWindows(gamma, "btc-up-or-down-5m", T0);
    await listSeriesWindows(gamma, "btc-up-or-down-5m", T0 + 1000);
    expect(seriesLookups()).toBe(1);
  });

  it("errors for a series slug upstream does not know", async () => {
    const { gamma } = buildGamma({ unknownSeries: true });
    const result = await listSeriesWindows(gamma, "not-a-series", T0);
    expect(result.ok).toBe(false);
  });

  it("propagates an upstream failure instead of inventing windows", async () => {
    const { gamma } = buildGamma({ windowFail: true });
    const result = await listSeriesWindows(gamma, "btc-up-or-down-5m", T0);
    expect(result.ok).toBe(false);
  });
});

describe("resolveSeriesWindow", () => {
  const unwrap = (r: { ok: boolean; value?: SeriesWindow | null }): SeriesWindow => {
    expect(r.ok).toBe(true);
    const w = r.value;
    if (!w) throw new Error("expected a window");
    return w;
  };

  it("selects the window that is open right now for 'current'", async () => {
    const { gamma } = buildGamma();
    const w = unwrap(
      await resolveSeriesWindow(gamma, {
        seriesSlug: "btc-up-or-down-5m",
        selector: "current",
        nowMs: T0,
      }),
    );
    expect(w.windowStartMs).toBe(LIVE_START);
    expect(w.windowEndMs).toBe(LIVE_START + WINDOW_MS);
    expect(w.windowStartMs).toBeLessThanOrEqual(T0);
    expect(w.windowEndMs).toBeGreaterThan(T0);
    expect(w.tokenIds).toHaveLength(2);
    expect(w.outcomes).toEqual(["Up", "Down"]);
  });

  it("selects the following pre-created window for 'next'", async () => {
    const { gamma } = buildGamma();
    const w = unwrap(
      await resolveSeriesWindow(gamma, {
        seriesSlug: "btc-up-or-down-5m",
        selector: "next",
        nowMs: T0,
      }),
    );
    expect(w.windowStartMs).toBe(LIVE_START + WINDOW_MS);
    // "next" is a real, tradable market that simply hasn't opened yet.
    expect(w.windowStartMs).toBeGreaterThan(T0);
    expect(w.conditionId).toBe(`cond-${Math.floor((LIVE_START + WINDOW_MS) / 1000)}`);
  });

  it("returns null rather than guessing when no window qualifies", async () => {
    const gammaEmpty = {
      ...buildGamma().gamma,
      listEventsPaginated: async () =>
        ok({ data: [], pagination: { hasMore: false, totalResults: 0 } }),
    } satisfies GammaClient;
    const result = await resolveSeriesWindow(gammaEmpty, {
      seriesSlug: "btc-up-or-down-5m",
      selector: "current",
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe("outcomeIndexOf", () => {
  it("matches outcome labels case-insensitively", () => {
    const w = { outcomes: ["Up", "Down"] } as unknown as SeriesWindow;
    expect(outcomeIndexOf(w, "up")).toBe(0);
    expect(outcomeIndexOf(w, " DOWN ")).toBe(1);
    expect(outcomeIndexOf(w, "Yes")).toBe(-1);
  });
});
