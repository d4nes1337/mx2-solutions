import { describe, expect, it } from "vitest";
import {
  DEMO_SCENARIOS,
  SYNTHETIC_POINTS,
  SYNTHETIC_WINDOW_MS,
  makeSyntheticSeries,
  scenarioPromptText,
  type ChartSpec,
} from "./demo-scenarios";

const END_MS = 1_760_000_000_000; // fixed reference so series are fully deterministic

describe("DEMO_SCENARIOS content", () => {
  it("has 5 scenarios with unique ids", () => {
    expect(DEMO_SCENARIOS).toHaveLength(5);
    expect(new Set(DEMO_SCENARIOS.map((s) => s.id)).size).toBe(5);
  });

  it.each(DEMO_SCENARIOS.map((s) => [s.id, s] as const))("%s validates", (_id, s) => {
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.prompt.length).toBeGreaterThan(0);
    expect(s.prompt.every((seg) => seg.text.length > 0)).toBe(true);
    expect(scenarioPromptText(s).length).toBeGreaterThan(20);

    // At least one market slot, highlighted as a market.
    const slots = s.prompt.filter((seg) => seg.isMarketSlot);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((seg) => seg.highlight === "market")).toBe(true);

    // Diagram covers condition → logic → action, appearAt within segment range.
    expect(new Set(s.diagram.map((c) => c.role))).toEqual(
      new Set(["condition", "logic", "action"]),
    );
    for (const chip of s.diagram) {
      expect(chip.label.length).toBeGreaterThan(0);
      expect(chip.appearAt).toBeGreaterThanOrEqual(0);
      expect(chip.appearAt).toBeLessThan(s.prompt.length);
    }

    // Chart spec is chartable and its markers land on the series.
    expect(s.chart.base).toBeGreaterThan(0);
    expect(s.chart.base).toBeLessThan(1);
    expect(s.chart.markers.length).toBeGreaterThan(0);
    for (const m of s.chart.markers) {
      expect(m.atFrac).toBeGreaterThanOrEqual(0);
      expect(m.atFrac).toBeLessThanOrEqual(1);
      expect(m.label.length).toBeGreaterThan(0);
    }

    expect(s.marketQuery.trim().length).toBeGreaterThanOrEqual(2);
    expect(s.buildPrompt.length).toBeGreaterThan(0);
  });
});

describe("makeSyntheticSeries", () => {
  it("emits 60 clamped points spanning the 7-day window", () => {
    for (const s of DEMO_SCENARIOS) {
      const series = makeSyntheticSeries(s.chart, 7, END_MS);
      expect(series).toHaveLength(SYNTHETIC_POINTS);
      expect(series[series.length - 1]!.t - series[0]!.t).toBe(SYNTHETIC_WINDOW_MS);
      for (let i = 0; i < series.length; i++) {
        expect(series[i]!.v).toBeGreaterThanOrEqual(0.01);
        expect(series[i]!.v).toBeLessThanOrEqual(0.99);
        if (i > 0) expect(series[i]!.t).toBeGreaterThan(series[i - 1]!.t);
      }
    }
  });

  it("is deterministic for the same seed and differs across seeds", () => {
    const spec = DEMO_SCENARIOS[0]!.chart;
    expect(makeSyntheticSeries(spec, 42, END_MS)).toEqual(makeSyntheticSeries(spec, 42, END_MS));
    const a = makeSyntheticSeries(spec, 1, END_MS).map((p) => p.v);
    const b = makeSyntheticSeries(spec, 2, END_MS).map((p) => p.v);
    expect(a).not.toEqual(b);
  });

  it("shapes actually shape the series", () => {
    const base = { base: 0.5, amplitude: 0.2, markers: [] };
    const spike = makeSyntheticSeries({ ...base, shape: "spike" } as ChartSpec, 3, END_MS);
    const decline = makeSyntheticSeries({ ...base, shape: "decline" } as ChartSpec, 3, END_MS);
    const dip = makeSyntheticSeries({ ...base, shape: "dip-recover" } as ChartSpec, 3, END_MS);

    // Spike ends well above where it starts; decline well below.
    expect(spike[spike.length - 1]!.v - spike[0]!.v).toBeGreaterThan(0.1);
    expect(decline[decline.length - 1]!.v - decline[0]!.v).toBeLessThan(-0.1);
    // Dip-recover bottoms out mid-window and comes back.
    const mid = dip[Math.round((dip.length - 1) / 2)]!.v;
    expect(mid).toBeLessThan(dip[0]!.v - 0.1);
    expect(dip[dip.length - 1]!.v).toBeGreaterThan(mid + 0.1);
  });
});
