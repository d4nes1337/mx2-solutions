import { describe, it, expect } from "vitest";
import { rankHits, understandQuery } from "./query-understanding.js";
import type { MarketSearchHit } from "./market-search.js";

// Thu 2026-07-17 12:00 UTC — fixed so date parsing is deterministic.
const NOW = Date.UTC(2026, 6, 17, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const windowFor = (anchorMs: number) => ({
  startMs: anchorMs - 36 * HOUR,
  endMs: anchorMs + 36 * HOUR,
});

const hit = (over: Partial<MarketSearchHit>): MarketSearchHit => ({
  eventId: "ev",
  marketId: "m",
  title: "",
  eventTitle: "",
  image: "",
  conditionId: "cond-default",
  tokenIds: ["t-yes", "t-no"],
  outcomes: ["Yes", "No"],
  outcomePrices: ["0.5", "0.5"],
  volume: "0",
  liquidity: "0",
  endDate: null,
  negRisk: false,
  rewardsMinSize: null,
  rewardsMaxSpread: null,
  groupItemTitle: "",
  bestBid: "0",
  bestAsk: "0",
  active: true,
  closed: false,
  sportsMarketType: null,
  ...over,
});

describe("understandQuery", () => {
  it("lowercases and strips filler words and punctuation", () => {
    const uq = understandQuery("Will the Market on Argentina?!", NOW);
    expect(uq.original).toBe("Will the Market on Argentina?!");
    expect(uq.cleaned).toBe("argentina");
    expect(uq.dateWindow).toBeNull();
    expect(uq.queries).toEqual(["argentina"]);
  });

  it("keeps all-filler queries instead of degrading to an empty query", () => {
    const uq = understandQuery("will the market", NOW);
    expect(uq.cleaned).toBe("will the market");
    expect(uq.queries).toEqual(["will the market"]);
  });

  it.each([
    ["messi scores 19.07", "19.07"],
    ["messi scores 19/07", "19/07"],
    ["messi scores july 19", "july 19"],
    ["messi scores 19 july", "19 july"],
    ["messi scores jul 19", "jul 19"],
  ])("parses %s into a ±36h window and removes the date token", (raw) => {
    const uq = understandQuery(raw, NOW);
    expect(uq.dateWindow).toEqual(windowFor(Date.UTC(2026, 6, 19, 12)));
    expect(uq.cleaned).toBe("messi scores");
    // Date tokens never leak into the fan-out queries.
    expect(uq.queries).toEqual(["messi scores", "messi goals"]);
  });

  it("parses month-first numeric dates when day-first is impossible", () => {
    const uq = understandQuery("final 7/19", NOW);
    expect(uq.dateWindow).toEqual(windowFor(Date.UTC(2026, 6, 19, 12)));
    expect(uq.cleaned).toBe("final");
  });

  it("does not read decimals as dates", () => {
    const uq = understandQuery("buy under 0.45", NOW);
    expect(uq.dateWindow).toBeNull();
    const uq2 = understandQuery("moves 1.5 cents", NOW);
    expect(uq2.dateWindow).toBeNull();
  });

  it("anchors today and tomorrow to nowMs", () => {
    expect(understandQuery("fixtures today", NOW).dateWindow).toEqual(windowFor(NOW));
    expect(understandQuery("fixtures tomorrow", NOW).dateWindow).toEqual(windowFor(NOW + DAY));
  });

  it("rolls a day-month more than 30 days in the past to next year", () => {
    const december = Date.UTC(2026, 11, 1);
    const uq = understandQuery("final 19.07", december);
    expect(uq.dateWindow).toEqual(windowFor(Date.UTC(2027, 6, 19, 12)));
  });

  it("keeps a day-month within the last 30 days in the current year", () => {
    const lateJuly = Date.UTC(2026, 6, 25);
    const uq = understandQuery("final 19.07", lateJuly);
    expect(uq.dateWindow).toEqual(windowFor(Date.UTC(2026, 6, 19, 12)));
  });

  it("expands synonyms into extra fan-out queries", () => {
    expect(understandQuery("wc final", NOW).queries).toEqual(["wc final", "fifa world cup final"]);
    expect(understandQuery("cs2 major", NOW).queries).toEqual([
      "cs2 major",
      "counter-strike major",
    ]);
    expect(understandQuery("usa vs uk", NOW).queries).toEqual([
      "usa vs uk",
      "united states vs uk",
      "usa vs united kingdom",
    ]);
  });

  it("caps at 3 queries (≤2 expansions)", () => {
    const uq = understandQuery("btc eth fed", NOW);
    expect(uq.queries).toHaveLength(3);
    expect(uq.queries).toEqual(["btc eth fed", "bitcoin eth fed", "btc ethereum fed"]);
  });

  it("skips expansions already contained in the query", () => {
    expect(understandQuery("fifa world cup", NOW).queries).toEqual(["fifa world cup"]);
  });
});

describe("rankHits", () => {
  const uqFor = (raw: string) => understandQuery(raw, NOW);

  it("dedups by conditionId keeping the first occurrence", () => {
    const a = hit({ conditionId: "c1", title: "Spain wins" });
    const b = hit({ conditionId: "c1", title: "Spain wins (dup)" });
    const c = hit({ conditionId: "c2", title: "Spain advances" });
    const ranked = rankHits([a, b, c], uqFor("spain"));
    expect(ranked).toHaveLength(2);
    expect(ranked.map((h) => h.title)).toContain("Spain wins");
    expect(ranked.map((h) => h.title)).not.toContain("Spain wins (dup)");
  });

  it("ranks lexical overlap above date fit and liquidity", () => {
    const uq = uqFor("argentina wins 19.07");
    const lexical = hit({ conditionId: "c1", title: "Argentina wins the final" });
    const dated = hit({
      conditionId: "c2",
      title: "Unrelated",
      endDate: new Date(Date.UTC(2026, 6, 19, 20)).toISOString(),
      liquidity: "1000000",
      volume: "1000000",
    });
    expect(rankHits([dated, lexical], uq)[0]!.conditionId).toBe("c1");
  });

  it("ranks date fit above liquidity when lexical is equal", () => {
    const uq = uqFor("argentina 19.07");
    const inWindow = hit({
      conditionId: "c1",
      title: "Argentina",
      endDate: new Date(Date.UTC(2026, 6, 19, 20)).toISOString(),
    });
    const deepButFar = hit({
      conditionId: "c2",
      title: "Argentina",
      endDate: new Date(Date.UTC(2026, 11, 31)).toISOString(),
      liquidity: "5000000",
      volume: "5000000",
    });
    expect(rankHits([deepButFar, inWindow], uq)[0]!.conditionId).toBe("c1");
  });

  it("decays date fit with distance outside the window", () => {
    const uq = uqFor("argentina 19.07");
    const near = hit({
      conditionId: "c1",
      title: "Argentina",
      endDate: new Date(Date.UTC(2026, 6, 22)).toISOString(),
    });
    const far = hit({
      conditionId: "c2",
      title: "Argentina",
      endDate: new Date(Date.UTC(2026, 8, 30)).toISOString(),
    });
    expect(rankHits([far, near], uq)[0]!.conditionId).toBe("c1");
  });

  it("breaks lexical ties by liquidity+volume depth", () => {
    const uq = uqFor("argentina");
    const shallow = hit({ conditionId: "c1", title: "Argentina", liquidity: "10", volume: "10" });
    const deep = hit({
      conditionId: "c2",
      title: "Argentina",
      liquidity: "500000",
      volume: "500000",
    });
    expect(rankHits([shallow, deep], uq)[0]!.conditionId).toBe("c2");
  });

  it("matches expansion tokens too (synonym recall)", () => {
    const uq = uqFor("btc dip");
    const bitcoin = hit({ conditionId: "c1", title: "Bitcoin dip below $100k" });
    const other = hit({ conditionId: "c2", title: "Ethereum dip below $5k" });
    expect(rankHits([other, bitcoin], uq)[0]!.conditionId).toBe("c1");
  });

  it("is deterministic for equal scores (input order preserved)", () => {
    const a = hit({ conditionId: "c1", title: "Same" });
    const b = hit({ conditionId: "c2", title: "Same" });
    const uq = uqFor("same");
    expect(rankHits([a, b], uq).map((h) => h.conditionId)).toEqual(["c1", "c2"]);
    expect(rankHits([b, a], uq).map((h) => h.conditionId)).toEqual(["c2", "c1"]);
  });
});
