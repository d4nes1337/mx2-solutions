import { describe, it, expect } from "vitest";
import { tightenedExpiry, type MarketMeta } from "./doc";

const NOW = Date.parse("2026-07-27T13:00:00Z");
const MIN = 60_000;

const instantMeta = (endOffsetMs: number): MarketMeta => ({
  title: "Bitcoin Up or Down",
  recurrence: "5m",
  endDate: new Date(NOW + endOffsetMs).toISOString(),
});

describe("tightenedExpiry", () => {
  it("defaults a null expiry to the instant market's window end", () => {
    expect(tightenedExpiry(null, instantMeta(4 * MIN), NOW)).toBe(NOW + 4 * MIN);
  });

  it("tightens a later user expiry down to the window end", () => {
    const userExpiry = NOW + 60 * MIN;
    expect(tightenedExpiry(userExpiry, instantMeta(4 * MIN), NOW)).toBe(NOW + 4 * MIN);
  });

  it("never loosens an earlier user expiry", () => {
    const userExpiry = NOW + 2 * MIN;
    expect(tightenedExpiry(userExpiry, instantMeta(4 * MIN), NOW)).toBe(userExpiry);
  });

  it("ignores non-recurring markets even when they have an endDate", () => {
    const meta: MarketMeta = {
      title: "One-off market",
      endDate: new Date(NOW + 4 * MIN).toISOString(),
    };
    expect(tightenedExpiry(null, meta, NOW)).toBe(null);
  });

  it("ignores recurring metas without a usable endDate or already past", () => {
    expect(tightenedExpiry(null, { title: "x", recurrence: "5m" }, NOW)).toBe(null);
    expect(tightenedExpiry(null, { title: "x", recurrence: "5m", endDate: "garbage" }, NOW)).toBe(
      null,
    );
    expect(tightenedExpiry(null, instantMeta(-1 * MIN), NOW)).toBe(null);
    expect(tightenedExpiry(null, undefined, NOW)).toBe(null);
  });
});
