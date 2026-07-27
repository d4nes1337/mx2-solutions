import { describe, it, expect } from "vitest";
import { GammaEventSchema } from "@mx2/polymarket-client";
import { eventHitFromGamma, type EventSearchHit } from "./market-search.js";
import { applySeriesHygiene, isDecided, isEnded } from "./search-hygiene.js";

const NOW = Date.parse("2026-07-27T13:00:00Z");
const HOUR = 3_600_000;

const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

/** Build an EventSearchHit through the real Gamma mapping so fixtures stay honest. */
const group = (over: {
  id: string;
  title: string;
  endDate: string;
  seriesSlug?: string;
  recurrence?: string;
  price?: string;
  liquidity?: string;
}): EventSearchHit => {
  const hit = eventHitFromGamma(
    GammaEventSchema.parse({
      id: over.id,
      title: over.title,
      endDate: over.endDate,
      ...(over.seriesSlug
        ? {
            seriesSlug: over.seriesSlug,
            series: [{ slug: over.seriesSlug, recurrence: over.recurrence ?? "5m" }],
          }
        : {}),
      markets: [
        {
          id: `m-${over.id}`,
          question: over.title,
          conditionId: `cond-${over.id}`,
          endDate: over.endDate,
          active: true,
          closed: false,
          liquidity: over.liquidity ?? "5000",
          volume: "1000",
          outcomes: '["Up","Down"]',
          outcomePrices: `["${over.price ?? "0.5"}","${(1 - Number(over.price ?? "0.5")).toFixed(2)}"]`,
          clobTokenIds: `["${over.id}-up","${over.id}-down"]`,
        },
      ],
    }),
  );
  if (!hit) throw new Error("fixture produced no markets");
  return hit;
};

describe("isDecided / isEnded", () => {
  it("flags ≤1¢ and ≥99¢ head prices as decided", () => {
    expect(
      isDecided(group({ id: "a", title: "t", endDate: iso(HOUR), price: "0.005" }).markets[0]!),
    ).toBe(true);
    expect(
      isDecided(group({ id: "b", title: "t", endDate: iso(HOUR), price: "0.999" }).markets[0]!),
    ).toBe(true);
    expect(
      isDecided(group({ id: "c", title: "t", endDate: iso(HOUR), price: "0.51" }).markets[0]!),
    ).toBe(false);
  });

  it("treats missing/garbage endDate as not ended", () => {
    expect(isEnded(null, NOW)).toBe(false);
    expect(isEnded("not-a-date", NOW)).toBe(false);
    expect(isEnded(iso(-1), NOW)).toBe(true);
    expect(isEnded(iso(+1), NOW)).toBe(false);
  });
});

describe("applySeriesHygiene", () => {
  it("hard-drops ended series instances but only demotes ended one-offs", () => {
    const staleInstance = group({
      id: "old-window",
      title: "Bitcoin Up or Down - Dec 19, 11:35AM",
      endDate: iso(-200 * 24 * HOUR),
      seriesSlug: "btc-up-or-down-5m",
    });
    const endedOneOff = group({
      id: "past-event",
      title: "Will X happen by June?",
      endDate: iso(-30 * 24 * HOUR),
    });
    const liveOneOff = group({
      id: "live-event",
      title: "Will Y happen?",
      endDate: iso(24 * HOUR),
    });

    const { primary, demoted } = applySeriesHygiene([staleInstance, endedOneOff, liveOneOff], NOW);
    expect(primary.map((g) => g.eventId)).toEqual(["live-event"]);
    expect(demoted.map((g) => g.eventId)).toEqual(["past-event"]);
  });

  it("collapses a series to its soonest-ending live window", () => {
    const current = group({
      id: "win-1",
      title: "Bitcoin Up or Down - 9:00-9:05AM",
      endDate: iso(2 * 60_000),
      seriesSlug: "btc-up-or-down-5m",
    });
    const next = group({
      id: "win-2",
      title: "Bitcoin Up or Down - 9:05-9:10AM",
      endDate: iso(7 * 60_000),
      seriesSlug: "btc-up-or-down-5m",
    });
    // Deliberately out of order.
    const { primary, demoted } = applySeriesHygiene([next, current], NOW);
    expect(primary.map((g) => g.eventId)).toEqual(["win-1"]);
    expect(demoted.map((g) => g.eventId)).toEqual(["win-2"]);
  });

  it("skips ahead when the soonest window is already decided", () => {
    const decidedWeekly = group({
      id: "wk-old",
      title: "MicroStrategy purchase July 21-27?",
      endDate: iso(10 * HOUR),
      seriesSlug: "mstr-weekly-strike",
      recurrence: "weekly",
      price: "0.005",
    });
    const nextWeekly = group({
      id: "wk-new",
      title: "MicroStrategy purchase July 28-August 3?",
      endDate: iso(7 * 24 * HOUR),
      seriesSlug: "mstr-weekly-strike",
      recurrence: "weekly",
      price: "0.16",
    });
    const { primary, demoted } = applySeriesHygiene([decidedWeekly, nextWeekly], NOW);
    expect(primary.map((g) => g.eventId)).toEqual(["wk-new"]);
    expect(demoted.map((g) => g.eventId)).toEqual(["wk-old"]);
  });

  it("keeps a decided window when it is the only instance", () => {
    const only = group({
      id: "solo",
      title: "Weekly thing?",
      endDate: iso(HOUR),
      seriesSlug: "some-weekly",
      price: "0.99",
    });
    const { primary, demoted } = applySeriesHygiene([only], NOW);
    expect(primary.map((g) => g.eventId)).toEqual(["solo"]);
    expect(demoted).toEqual([]);
  });
});
