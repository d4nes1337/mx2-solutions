import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err, type Result } from "@mx2/core";
import {
  GammaEventSchema,
  type GammaClient,
  type GammaEvent,
  type PolymarketError,
} from "@mx2/polymarket-client";
import {
  resetSmartSearchCache,
  searchMarketHits,
  smartSearchEventHits,
  smartSearchMarketHits,
} from "./market-search.js";

const upstreamErr: PolymarketError = { code: "UPSTREAM_ERROR", message: "x", statusCode: 502 };

const eventFor = (conditionId: string, title: string, over: Record<string, unknown> = {}) =>
  GammaEventSchema.parse({
    id: `ev-${conditionId}`,
    title,
    markets: [
      {
        id: `m-${conditionId}`,
        question: `${title}?`,
        conditionId,
        active: true,
        closed: false,
        liquidity: "1000",
        volume: "1000",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.5","0.5"]',
        clobTokenIds: `["${conditionId}-yes","${conditionId}-no"]`,
        ...over,
      },
    ],
  });

interface SearchCall {
  query: string;
  limit: number | undefined;
  opts: { status?: "active" | "any" } | undefined;
}

const makeGamma = (
  impl: (
    query: string,
    limit?: number,
    opts?: { status?: "active" | "any" },
  ) => Promise<Result<GammaEvent[], PolymarketError>>,
) => {
  const calls: SearchCall[] = [];
  const gamma: GammaClient = {
    listEvents: async () => ok([]),
    getEvent: async () => err(upstreamErr),
    listMarkets: async () => ok([]),
    getMarket: async () => err(upstreamErr),
    getPublicProfile: async () => ok(null),
    findMarket: async () => ok(null),
    searchMarkets: async (query, limit, opts) => {
      calls.push({ query, limit, opts });
      return impl(query, limit, opts);
    },
  };
  return { gamma, calls };
};

const threeEvents = [
  eventFor("c1", "Argentina wins the World Cup"),
  eventFor("c2", "Argentina reaches the final"),
  eventFor("c3", "Argentina top scorer"),
];

beforeEach(() => resetSmartSearchCache());
afterEach(() => vi.useRealTimers());

describe("searchMarketHits", () => {
  it("collapses events to their first active market (unchanged behavior)", async () => {
    const { gamma } = makeGamma(async () => ok([eventFor("c1", "Will it rain?")]));
    const result = await searchMarketHits(gamma, "rain", 8);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.conditionId).toBe("c1");
    expect(result.value[0]!.tokenIds).toEqual(["c1-yes", "c1-no"]);
  });
});

describe("smartSearchMarketHits", () => {
  it("fans out one Gamma query per understood query, bounded by maxFanOut", async () => {
    const { gamma, calls } = makeGamma(async () => ok(threeEvents));
    // "btc scores" understands to 3 queries (scores→goals, btc→bitcoin).
    const result = await smartSearchMarketHits(gamma, "btc scores", { limit: 15, maxFanOut: 2 });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.query)).toEqual(["btc scores", "btc goals"]);
    expect(calls.every((c) => c.limit === 20)).toBe(true);
    expect(calls.every((c) => c.opts === undefined)).toBe(true);
  });

  it("defaults to (and caps at) 3 fan-out queries", async () => {
    const { gamma, calls } = makeGamma(async () => ok(threeEvents));
    await smartSearchMarketHits(gamma, "btc scores", { limit: 15 });
    expect(calls.map((c) => c.query)).toEqual(["btc scores", "btc goals", "bitcoin scores"]);
  });

  it("dedups hits by conditionId across fan-out queries", async () => {
    const { gamma } = makeGamma(async () => ok(threeEvents));
    const result = await smartSearchMarketHits(gamma, "btc scores", { limit: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((h) => h.conditionId).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("widens ONCE with status any when unique hits are thin", async () => {
    const { gamma, calls } = makeGamma(async (_query, _limit, opts) =>
      opts?.status === "any"
        ? ok([eventFor("c8", "Argentina wins"), eventFor("c9", "Argentina draws")])
        : ok([eventFor("c1", "Argentina")]),
    );
    const result = await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1 query ("argentina" has no synonyms) + 1 widening retry.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ query: "argentina", limit: 20, opts: { status: "any" } });
    expect(result.value.map((h) => h.conditionId).sort()).toEqual(["c1", "c8", "c9"]);
  });

  it("does not widen when the first pass already found 3+ unique hits", async () => {
    const { gamma, calls } = makeGamma(async () => ok(threeEvents));
    await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toBeUndefined();
  });

  it("slices to the requested limit after ranking", async () => {
    const { gamma } = makeGamma(async () =>
      ok([1, 2, 3, 4, 5].map((i) => eventFor(`c${i}`, `Market ${i}`))),
    );
    const result = await smartSearchMarketHits(gamma, "market 42", { limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it("ranks the best lexical match first across fan-out results", async () => {
    const { gamma } = makeGamma(async (query) =>
      query === "bitcoin dip"
        ? ok([eventFor("c-btc", "Bitcoin dips below $100k"), eventFor("c4", "Something else")])
        : ok([eventFor("c-eth", "Ethereum flips"), eventFor("c5", "Rain in Paris")]),
    );
    const result = await smartSearchMarketHits(gamma, "btc dip", { limit: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.conditionId).toBe("c-btc");
  });

  it("serves the 30s TTL cache, then refetches after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00Z"));
    const { gamma, calls } = makeGamma(async () => ok(threeEvents));

    await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(calls).toHaveLength(1);

    const cachedResult = await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(calls).toHaveLength(1); // cache hit — no new Gamma call
    expect(cachedResult.ok).toBe(true);

    vi.setSystemTime(new Date("2026-07-17T12:00:31Z"));
    await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(calls).toHaveLength(2); // TTL expired — refetched
  });

  it("normalizes the cache key (filler/punctuation/date variants share one entry)", async () => {
    const { gamma, calls } = makeGamma(async () => ok(threeEvents));
    await smartSearchMarketHits(gamma, "Argentina!", { limit: 15 });
    await smartSearchMarketHits(gamma, "will the argentina", { limit: 15 });
    expect(calls).toHaveLength(1);
  });

  it("shares a single inflight fetch between concurrent callers", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { gamma, calls } = makeGamma(async () => {
      await gate;
      return ok(threeEvents);
    });

    const first = smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    const second = smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toHaveLength(1); // one Gamma round for both callers
  });

  it("propagates the error when every fan-out query fails, and does not cache it", async () => {
    let failing = true;
    const { gamma, calls } = makeGamma(async () => (failing ? err(upstreamErr) : ok(threeEvents)));
    const bad = await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("UPSTREAM_ERROR");

    failing = false;
    const good = await smartSearchMarketHits(gamma, "argentina", { limit: 15 });
    expect(good.ok).toBe(true); // errors are not cached — next call retries
    expect(calls.length).toBeGreaterThan(1);
  });

  it("keeps partial fan-out results when only some queries fail", async () => {
    const { gamma } = makeGamma(async (query) =>
      query === "btc scores" ? ok(threeEvents) : err(upstreamErr),
    );
    const result = await smartSearchMarketHits(gamma, "btc scores", { limit: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });
});

// ── Event-grouped search (sub-markets: totals, spreads, candidates) ──────────

const subMarket = (conditionId: string, over: Record<string, unknown> = {}) => ({
  id: `m-${conditionId}`,
  question: `${conditionId}?`,
  conditionId,
  active: true,
  closed: false,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  clobTokenIds: `["${conditionId}-yes","${conditionId}-no"]`,
  ...over,
});

const sportsEvent = GammaEventSchema.parse({
  id: "ev-match",
  title: "Real Madrid vs Barcelona",
  markets: [
    subMarket("c-total", { groupItemTitle: "Over 2.5", sportsMarketType: "totals" }),
    subMarket("c-closed", { groupItemTitle: "First half", active: false, closed: true }),
    subMarket("c-money", { groupItemTitle: "Moneyline", sportsMarketType: "moneyline" }),
    subMarket("c-spread", { groupItemTitle: "Spread -1.5", sportsMarketType: "spreads" }),
  ],
});

const electionEvent = GammaEventSchema.parse({
  id: "ev-election",
  title: "Presidential Election Winner",
  negRisk: true,
  markets: [
    subMarket("c-underdog", { groupItemTitle: "Underdog", outcomePrices: '["0.08","0.92"]' }),
    subMarket("c-favorite", { groupItemTitle: "Favorite", outcomePrices: '["0.61","0.39"]' }),
    subMarket("c-second", { groupItemTitle: "Runner-up", outcomePrices: '["0.27","0.73"]' }),
  ],
});

describe("smartSearchEventHits", () => {
  it("returns events with ALL sub-markets, ordered: open first, sports by type", async () => {
    const { gamma } = makeGamma(async () => ok([sportsEvent]));
    const result = await smartSearchEventHits(gamma, "real madrid", { limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const event = result.value[0]!;
    expect(event.title).toBe("Real Madrid vs Barcelona");
    expect(event.markets.map((m) => m.conditionId)).toEqual([
      "c-money",
      "c-spread",
      "c-total",
      "c-closed", // closed sinks to the bottom
    ]);
    expect(event.markets[0]!.groupItemTitle).toBe("Moneyline");
  });

  it("orders neg-risk candidates by price, favorite first", async () => {
    const { gamma } = makeGamma(async () => ok([electionEvent]));
    const result = await smartSearchEventHits(gamma, "election", { limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.negRisk).toBe(true);
    expect(result.value[0]!.markets.map((m) => m.conditionId)).toEqual([
      "c-favorite",
      "c-second",
      "c-underdog",
    ]);
  });

  it("shares one cache entry with the flat search (no extra Gamma traffic)", async () => {
    const { gamma, calls } = makeGamma(async () => ok([sportsEvent]));
    await smartSearchMarketHits(gamma, "real madrid", { limit: 15 });
    const before = calls.length;
    const grouped = await smartSearchEventHits(gamma, "real madrid", { limit: 10 });
    expect(calls.length).toBe(before); // served from the shared cache
    expect(grouped.ok).toBe(true);
  });

  it("collapses the flat view to the ordered head market of each event", async () => {
    const { gamma } = makeGamma(async () => ok([sportsEvent, electionEvent, ...threeEvents]));
    const flat = await smartSearchMarketHits(gamma, "anything at all", { limit: 15 });
    expect(flat.ok).toBe(true);
    if (!flat.ok) return;
    const byEvent = new Map(flat.value.map((h) => [h.eventId, h]));
    expect(byEvent.get("ev-match")?.conditionId).toBe("c-money");
    expect(byEvent.get("ev-election")?.conditionId).toBe("c-favorite");
  });

  it("caps sub-markets per event via marketsPerEvent", async () => {
    const { gamma } = makeGamma(async () => ok([electionEvent]));
    const result = await smartSearchEventHits(gamma, "election", {
      limit: 10,
      marketsPerEvent: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.markets).toHaveLength(2);
    expect(result.value[0]!.markets[0]!.conditionId).toBe("c-favorite");
  });
});
