/**
 * Curated hero demo content (Slice 5). Each scenario is ONE sentence encoded
 * as typed segments (the auto-typer colors them by kind), a diagram chip row
 * that reveals as its `appearAt` segment finishes typing, and a chart recipe
 * for the deterministic synthetic fallback series. Live market binding is
 * layered on top by use-scenario-binding; when it fails these synthetic
 * series render with an "illustrative" caption (honesty bar, R-023).
 */
import type { ChartPoint } from "@/components/charts/AreaChart";

export type HighlightKind = "market" | "logic" | "number" | "action";

export interface TypedSegment {
  text: string;
  highlight?: HighlightKind;
  /** Rendered as a market pill; live binding swaps in the real market title. */
  isMarketSlot?: boolean;
}

export interface DiagramChip {
  role: "condition" | "logic" | "action";
  /** May contain "{market}" — consumers substitute the bound market title. */
  label: string;
  /** Segment index: the chip reveals once this segment is fully typed. */
  appearAt: number;
}

export interface ChartMarker {
  kind: "entry" | "exit" | "alert";
  /** Position along the series, 0..1. */
  atFrac: number;
  label: string;
}

export interface ChartSpec {
  shape: "spike" | "range" | "dip-recover" | "decline" | "threshold-break";
  /** Resting price level, probability units (0.18 = 18¢). */
  base: number;
  /** Size of the shape's move, probability units. */
  amplitude: number;
  markers: ChartMarker[];
}

export interface DemoScenario {
  id: string;
  title: string;
  /** The sentence the fake user "types", split into highlightable segments. */
  prompt: readonly TypedSegment[];
  diagram: readonly DiagramChip[];
  chart: ChartSpec;
  /** Smart-search query for live market binding at render time. */
  marketQuery: string;
  /** Ready-to-fire AI prompt for "Build this" → /smart-orders/new?prompt=. */
  buildPrompt: string;
}

/** The full sentence a scenario types out. */
export const scenarioPromptText = (scenario: DemoScenario): string =>
  scenario.prompt.map((seg) => seg.text).join("");

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: "news-momentum",
    title: "News-momentum cross-market",
    prompt: [
      { text: "If ", highlight: "logic" },
      { text: "@Trump-Iran market", highlight: "market", isMarketSlot: true },
      { text: " jumps " },
      { text: "30%+", highlight: "number" },
      { text: " in " },
      { text: "an hour", highlight: "number" },
      { text: ", " },
      { text: "buy", highlight: "action" },
      { text: " " },
      { text: "@Bitcoin-dip market", highlight: "market", isMarketSlot: true },
      { text: " this week under " },
      { text: "20¢", highlight: "number" },
    ],
    diagram: [
      { role: "condition", label: "Trump-Iran jumps 30% in 1h", appearAt: 5 },
      { role: "logic", label: "then", appearAt: 6 },
      { role: "action", label: "Buy {market} under 20¢", appearAt: 11 },
    ],
    chart: {
      shape: "spike",
      base: 0.18,
      amplitude: 0.42,
      markers: [
        { kind: "entry", atFrac: 0.55, label: "Enter 18¢" },
        { kind: "exit", atFrac: 0.9, label: "Exit 60¢" },
      ],
    },
    marketQuery: "bitcoin",
    buildPrompt:
      "If the Trump-Iran market jumps 30% within an hour, buy $100 of YES on the Bitcoin dip market this week under 20 cents",
  },
  {
    id: "maker-range",
    title: "Maker range farming",
    prompt: [
      { text: "While ", highlight: "logic" },
      { text: "@Spain wins the World Cup", highlight: "market", isMarketSlot: true },
      { text: " trades " },
      { text: "55–57¢", highlight: "number" },
      { text: " with " },
      { text: "$50K+ liquidity", highlight: "number" },
      { text: ", keep " },
      { text: "buying", highlight: "action" },
      { text: " " },
      { text: "55–56¢", highlight: "number" },
      { text: " / " },
      { text: "selling", highlight: "action" },
      { text: " " },
      { text: "57–58¢", highlight: "number" },
      { text: " with limit orders" },
    ],
    diagram: [
      { role: "condition", label: "{market} pinned 55–57¢", appearAt: 5 },
      { role: "logic", label: "while", appearAt: 6 },
      { role: "action", label: "Quote 55–56¢ / 57–58¢", appearAt: 14 },
    ],
    chart: {
      shape: "range",
      base: 0.56,
      amplitude: 0.02,
      markers: [
        { kind: "entry", atFrac: 0.25, label: "Bid filled 55¢" },
        { kind: "exit", atFrac: 0.5, label: "Ask filled 58¢" },
        { kind: "entry", atFrac: 0.75, label: "Bid filled 56¢" },
      ],
    },
    marketQuery: "spain world cup",
    buildPrompt:
      "While the Spain wins the World Cup market trades between 55 and 57 cents with at least $50K of liquidity, keep resting maker buys at 55-56 cents and sells at 57-58 cents with limit orders",
  },
  {
    id: "trailing-stop",
    title: "Trailing-stop protection",
    prompt: [
      { text: "I hold " },
      { text: "@Team Spirit wins the CS2 Major", highlight: "market", isMarketSlot: true },
      { text: " — " },
      { text: "if", highlight: "logic" },
      { text: " it falls " },
      { text: "15%", highlight: "number" },
      { text: " from its peak, " },
      { text: "sell", highlight: "action" },
      { text: " at best price with a trailing stop" },
    ],
    diagram: [
      { role: "condition", label: "{market} falls 15% from peak", appearAt: 5 },
      { role: "logic", label: "then", appearAt: 6 },
      { role: "action", label: "Sell at best price", appearAt: 8 },
    ],
    chart: {
      shape: "decline",
      base: 0.62,
      amplitude: 0.3,
      markers: [
        { kind: "exit", atFrac: 0.52, label: "Trailing stop exits 59¢" },
        { kind: "alert", atFrac: 0.88, label: "Crash to 30¢ avoided" },
      ],
    },
    marketQuery: "cs2 major",
    buildPrompt:
      "I hold YES on Team Spirit winning the CS2 Major — protect it with a trailing stop that sells at the best price if it falls 15% from its peak",
  },
  {
    id: "dip-buy",
    title: "Live-match dip-buy",
    prompt: [
      { text: "If ", highlight: "logic" },
      { text: "@Argentina wins the World Cup", highlight: "market", isMarketSlot: true },
      { text: " drops " },
      { text: "20%+", highlight: "number" },
      { text: " in " },
      { text: "10 minutes", highlight: "number" },
      { text: " during the match, " },
      { text: "buy", highlight: "action" },
      { text: " " },
      { text: "$200", highlight: "number" },
      { text: " in three slices below " },
      { text: "45¢", highlight: "number" },
    ],
    diagram: [
      { role: "condition", label: "{market} drops 20% in 10m", appearAt: 5 },
      { role: "logic", label: "then", appearAt: 6 },
      { role: "action", label: "Buy $200 below 45¢", appearAt: 11 },
    ],
    chart: {
      shape: "dip-recover",
      base: 0.52,
      amplitude: 0.14,
      markers: [
        { kind: "entry", atFrac: 0.42, label: "Slice 1 @ 44¢" },
        { kind: "entry", atFrac: 0.5, label: "Slice 2 @ 42¢" },
        { kind: "entry", atFrac: 0.58, label: "Slice 3 @ 43¢" },
      ],
    },
    marketQuery: "argentina world cup",
    buildPrompt:
      "If the Argentina wins the World Cup market drops 20% within 10 minutes during the match, buy $200 of YES in three slices below 45 cents",
  },
  {
    id: "threshold-entry",
    title: "Confirmed threshold entry",
    prompt: [
      { text: "If ", highlight: "logic" },
      { text: "@Fed cuts rates in September", highlight: "market", isMarketSlot: true },
      { text: " holds above " },
      { text: "70¢", highlight: "number" },
      { text: " for " },
      { text: "6 hours", highlight: "number" },
      { text: " and ", highlight: "logic" },
      { text: "volume doubles" },
      { text: ", " },
      { text: "buy", highlight: "action" },
      { text: " YES up to " },
      { text: "74¢", highlight: "number" },
      { text: "; " },
      { text: "alert", highlight: "action" },
      { text: " me if it gaps" },
    ],
    diagram: [
      { role: "condition", label: "{market} holds >70¢ for 6h + volume 2×", appearAt: 7 },
      { role: "logic", label: "then", appearAt: 8 },
      { role: "action", label: "Buy up to 74¢ · alert on gap", appearAt: 13 },
    ],
    chart: {
      shape: "threshold-break",
      base: 0.68,
      amplitude: 0.09,
      markers: [
        { kind: "entry", atFrac: 0.72, label: "Confirmed entry 72¢" },
        { kind: "alert", atFrac: 0.9, label: "Gap alert" },
      ],
    },
    marketQuery: "fed rate cut september",
    buildPrompt:
      "If the Fed cuts rates in September market holds above 70 cents for 6 hours and volume doubles, buy YES up to 74 cents and alert me if it gaps",
  },
];

// ── Synthetic series ────────────────────────────────────────────────────────

export const SYNTHETIC_POINTS = 60;
export const SYNTHETIC_WINDOW_MS = 7 * 86_400_000;

/** mulberry32 — tiny deterministic PRNG; seed fully defines the stream. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Smooth 0→1 ramp (no visible corners on the chart). */
const smoothstep = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Shape envelope: fraction f (0..1) → value before noise. */
const shapeValue = (spec: ChartSpec, f: number): number => {
  const { base, amplitude } = spec;
  switch (spec.shape) {
    case "spike":
      // Flat, then a fast ramp from f=0.5 peaking by f=0.9 and holding.
      return base + amplitude * smoothstep((f - 0.5) / 0.4);
    case "range":
      // Oscillate inside the band around base.
      return base + amplitude * 0.8 * Math.sin(f * Math.PI * 6);
    case "dip-recover": {
      // Gaussian dip centered mid-window, recovering to base.
      const bell = Math.exp(-(((f - 0.5) / 0.16) ** 2));
      return base - amplitude * bell;
    }
    case "decline":
      // Gentle rise into a peak at f=0.35, then a steady slide to base−amplitude.
      return f < 0.35
        ? base + amplitude * 0.12 * smoothstep(f / 0.35)
        : base + amplitude * 0.12 - amplitude * 1.12 * smoothstep((f - 0.35) / 0.65);
    case "threshold-break":
      // Grind just under the level, then break out from f=0.6 and hold.
      return base - amplitude * 0.15 + amplitude * 1.15 * smoothstep((f - 0.6) / 0.25);
  }
};

/**
 * Deterministic synthetic price series: 60 points over a 7-day window shaped
 * by the spec, with seeded noise. Same (spec, seed, endMs) → same series.
 * Values are clamped to [0.01, 0.99] (probability bounds).
 */
export function makeSyntheticSeries(
  spec: ChartSpec,
  seed: number,
  endMs = Date.now(),
): ChartPoint[] {
  const rand = mulberry32(seed);
  const startMs = endMs - SYNTHETIC_WINDOW_MS;
  const stepMs = SYNTHETIC_WINDOW_MS / (SYNTHETIC_POINTS - 1);
  const noiseScale = Math.max(0.004, spec.amplitude * 0.06);

  return Array.from({ length: SYNTHETIC_POINTS }, (_, i) => {
    const f = i / (SYNTHETIC_POINTS - 1);
    const noise = (rand() - 0.5) * 2 * noiseScale;
    const v = Math.min(0.99, Math.max(0.01, shapeValue(spec, f) + noise));
    return { t: Math.round(startMs + i * stepMs), v: Math.round(v * 10_000) / 10_000 };
  });
}
