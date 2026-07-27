import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err } from "@mx2/core";
import {
  GammaEventSchema,
  type GammaClient,
  type GammaEvent,
  type GammaSeries,
  type ListEventsPaginatedParams,
  type PolymarketError,
} from "@mx2/polymarket-client";
import {
  CURATED_SERIES,
  getInstantMarkets,
  resetInstantMarketsCache,
  resolveSeriesWindows,
} from "./instant-markets.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const T0 = Date.parse("2026-07-27T13:21:00Z");
const MIN = 60_000;

/** A pre-created up/down instance: slug carries the unix window start. */
const windowEvent = (seriesSlug: string, windowStartMs: number, cadenceMs: number): GammaEvent => {
  const startSec = Math.floor(windowStartMs / 1000);
  const asset = seriesSlug.split("-")[0]!;
  return GammaEventSchema.parse({
    id: `ev-${asset}-${startSec}`,
    slug: `${asset}-updown-5m-${startSec}`,
    title: `Up or Down ${new Date(windowStartMs).toISOString()}`,
    endDate: new Date(windowStartMs + cadenceMs).toISOString(),
    // Gamma's startDate is CREATION time, hours before the window — the code
    // must not trust it for the window open time.
    startDate: new Date(windowStartMs - 10 * 3_600_000).toISOString(),
    seriesSlug,
    markets: [
      {
        id: `m-${asset}-${startSec}`,
        question: "Up or Down?",
        conditionId: `cond-${asset}-${startSec}`,
        endDate: new Date(windowStartMs + cadenceMs).toISOString(),
        active: true,
        closed: false,
        liquidity: "18000",
        outcomes: '["Up","Down"]',
        outcomePrices: '["0.51","0.49"]',
        clobTokenIds: `["${asset}-${startSec}-up","${asset}-${startSec}-down"]`,
      },
    ],
  });
};

const seriesFor = (slug: string, id: string): GammaSeries =>
  ({ id, slug, title: slug, recurrence: "daily", active: true, events: [] }) as GammaSeries;

const buildGamma = (opts?: { failWindows?: Set<string> }) => {
  const windowCalls: ListEventsPaginatedParams[] = [];
  const curWindow = Math.floor(T0 / (5 * MIN)) * (5 * MIN); // live 5m window start

  const gamma = {
    listEvents: async () => ok([]),
    listEventsPaginated: async (params?: ListEventsPaginatedParams) => {
      windowCalls.push(params ?? {});
      const id = params?.series_id ?? "";
      const slug = CURATED_SERIES.find((c) => `id-${c.slug}` === id)?.slug;
      if (!slug) return err(upstreamErr);
      if (opts?.failWindows?.has(slug)) return err(upstreamErr);
      const cadence = 5 * MIN;
      return ok({
        data: [0, 1, 2, 3].map((i) => windowEvent(slug, curWindow + i * cadence, cadence)),
        pagination: { hasMore: true, totalResults: 280 },
      });
    },
    getSeries: async ({ slug }: { slug: string }) =>
      CURATED_SERIES.some((c) => c.slug === slug)
        ? ok([seriesFor(slug, `id-${slug}`)])
        : ok([] as GammaSeries[]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async () => ok([]),
  } satisfies GammaClient;

  return { gamma, windowCalls, curWindow };
};

beforeEach(() => {
  resetInstantMarketsCache();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => vi.useRealTimers());

describe("resolveSeriesWindows", () => {
  it("always sends end_date_min (stale never-closed instances otherwise)", async () => {
    const { gamma, windowCalls } = buildGamma();
    await resolveSeriesWindows(gamma, "id-btc-up-or-down-5m", new Date(T0).toISOString());
    expect(windowCalls[0]).toMatchObject({
      series_id: "id-btc-up-or-down-5m",
      closed: false,
      end_date_min: new Date(T0).toISOString(),
      order: "endDate",
      ascending: true,
    });
    expect(windowCalls[0]).not.toHaveProperty("active");
  });
});

describe("getInstantMarkets", () => {
  it("returns curated series with the live window first, then upcoming", async () => {
    const { gamma, curWindow } = buildGamma();
    const result = await getInstantMarkets(gamma);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.degraded).toEqual([]);
    expect(result.value.series.length).toBe(CURATED_SERIES.length);

    const btc = result.value.series.find((s) => s.seriesSlug === "btc-up-or-down-5m")!;
    expect(btc.windows).toHaveLength(3); // capped
    expect(btc.windows[0]!.status).toBe("live");
    expect(btc.windows[0]!.startDate).toBe(new Date(curWindow).toISOString());
    expect(btc.windows[1]!.status).toBe("upcoming");
    // The bindable payload is a full MarketSearchHit with curated identity.
    expect(btc.windows[0]!.market.tokenIds).toHaveLength(2);
    expect(btc.windows[0]!.market.seriesSlug).toBe("btc-up-or-down-5m");
    expect(btc.windows[0]!.market.recurrence).toBe("5m"); // NOT Gamma's "daily"
  });

  it("serves the shared cache within 15s, refetches after", async () => {
    const { gamma, windowCalls } = buildGamma();
    await getInstantMarkets(gamma);
    const fetches = windowCalls.length;
    await getInstantMarkets(gamma);
    expect(windowCalls.length).toBe(fetches);

    vi.advanceTimersByTime(16_000);
    await getInstantMarkets(gamma);
    expect(windowCalls.length).toBe(fetches * 2);
  });

  it("reports failing series as degraded, keeps the rest", async () => {
    const { gamma } = buildGamma({ failWindows: new Set(["eth-up-or-down-5m"]) });
    const result = await getInstantMarkets(gamma);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.degraded).toContain("eth-up-or-down-5m");
    expect(result.value.series.some((s) => s.seriesSlug === "eth-up-or-down-5m")).toBe(false);
    expect(result.value.series.some((s) => s.seriesSlug === "btc-up-or-down-5m")).toBe(true);
  });

  it("serves stale-on-error within 2 minutes of the last good response", async () => {
    const { gamma } = buildGamma();
    const good = await getInstantMarkets(gamma);
    expect(good.ok).toBe(true);

    const { gamma: deadGamma } = buildGamma({
      failWindows: new Set(CURATED_SERIES.map((c) => c.slug)),
    });
    vi.advanceTimersByTime(30_000);
    const stale = await getInstantMarkets(deadGamma);
    expect(stale.ok).toBe(true); // last good response served

    vi.advanceTimersByTime(2 * 60_000);
    const dead = await getInstantMarkets(deadGamma);
    expect(dead.ok).toBe(false);
  });
});
