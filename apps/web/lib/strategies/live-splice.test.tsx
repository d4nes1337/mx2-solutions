import { describe, expect, it } from "vitest";
import { liveMid, spliceLive } from "./live-splice";

const NOW = 1_753_800_000_000; // ms
const secs = (offsetS: number) => Math.floor(NOW / 1000) + offsetS;

describe("liveMid", () => {
  it("averages a two-sided book, falls back one-sided, null when empty", () => {
    expect(liveMid({ bestBid: 0.56, bestAsk: 0.58 })).toBeCloseTo(0.57);
    expect(liveMid({ bestBid: null, bestAsk: 0.58 })).toBe(0.58);
    expect(liveMid({ bestBid: 0.56, bestAsk: null })).toBe(0.56);
    expect(liveMid({ bestBid: null, bestAsk: null })).toBeNull();
    expect(liveMid(undefined)).toBeNull();
  });
});

describe("spliceLive", () => {
  const series = [
    { t: secs(-600), v: 0.5 },
    { t: secs(-300), v: 0.52 },
    { t: secs(-60), v: 0.54 },
  ];

  it("appends the live mid in the series' own unit (seconds)", () => {
    const out = spliceLive(series, { bestBid: 0.56, bestAsk: 0.58, dataAgeMs: 2_000 }, NOW);
    expect(out.spliced).toBe(true);
    expect(out.series).toHaveLength(4);
    const appended = out.series[out.series.length - 1]!;
    expect(appended.v).toBeCloseTo(0.57);
    expect(appended.t).toBe(secs(-2)); // seconds, quote age respected
    expect(appended.t).toBeGreaterThan(series[series.length - 1]!.t);
  });

  it("keeps millisecond series in milliseconds", () => {
    const msSeries = [
      { t: NOW - 600_000, v: 0.5 },
      { t: NOW - 60_000, v: 0.54 },
    ];
    const out = spliceLive(msSeries, { bestBid: 0.5, bestAsk: 0.52 }, NOW);
    expect(out.spliced).toBe(true);
    expect(out.series[out.series.length - 1]!.t).toBe(NOW);
  });

  it("drops trailing points at/after the live moment — never a backwards segment", () => {
    const withFuture = [...series, { t: secs(30), v: 0.9 }];
    const out = spliceLive(withFuture, { bestBid: 0.56, bestAsk: 0.58, dataAgeMs: 0 }, NOW);
    expect(out.spliced).toBe(true);
    const ts = out.series.map((p) => p.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts); // strictly ordered
    expect(out.series.some((p) => p.v === 0.9)).toBe(false);
  });

  it("bails when every point is in the future (clock skew)", () => {
    const future = [
      { t: secs(100), v: 0.4 },
      { t: secs(200), v: 0.41 },
    ];
    const out = spliceLive(future, { bestBid: 0.5, bestAsk: 0.52 }, NOW);
    expect(out.spliced).toBe(false);
    expect(out.series).toBe(future);
  });

  it("never splices a stale (>60s) or missing quote, or an empty series", () => {
    expect(
      spliceLive(series, { bestBid: 0.5, bestAsk: 0.52, dataAgeMs: 61_000 }, NOW).spliced,
    ).toBe(false);
    expect(spliceLive(series, null, NOW).spliced).toBe(false);
    expect(spliceLive(series, { bestBid: null, bestAsk: null }, NOW).spliced).toBe(false);
    expect(spliceLive([], { bestBid: 0.5, bestAsk: 0.52 }, NOW).spliced).toBe(false);
  });

  it("guarantees a monotonically increasing timestamp even when the last candle touches liveT", () => {
    const tight = [
      { t: secs(-10), v: 0.5 },
      { t: secs(-1), v: 0.52 },
    ];
    const out = spliceLive(tight, { bestBid: 0.56, bestAsk: 0.58, dataAgeMs: 1_000 }, NOW);
    expect(out.spliced).toBe(true);
    const [a, b] = out.series.slice(-2);
    expect(b!.t).toBeGreaterThan(a!.t);
  });
});
