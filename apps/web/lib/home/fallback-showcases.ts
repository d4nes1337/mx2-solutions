/**
 * Curated sample showcases (Slice 6): shown when /api/showcases has nothing
 * yet, so the "Proven plays" cards never lose their charts. Flagged
 * `sample: true` — consumers must caption them as samples, not live
 * backtests (honesty bar, R-023). Series are deterministic synthetics
 * (seeded), quantized to the hour so SSR and client render the same values.
 */
import type { MarketRef, StrategyDefinition } from "@mx2/rules";
import type { ChartPoint } from "@/components/charts/AreaChart";
import type { PricePoint, Showcase } from "../types";
import { makeSyntheticSeries, type ChartSpec } from "./demo-scenarios";

export type FallbackShowcase = Showcase & { readonly sample: true };

const WINDOW_END_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const WINDOW_DAYS = 30;

const toPricePoints = (series: ChartPoint[]): PricePoint[] =>
  series.map((pt) => ({ t: pt.t, p: pt.v }));

const at = (series: ChartPoint[], frac: number): ChartPoint =>
  series[Math.round(frac * (series.length - 1))]!;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Dip-buy (mirrors the live showcase engine's archetype) ──────────────────

const dipRef: MarketRef = {
  conditionId: "sample-dip-buy",
  tokenId: "sample-dip-buy-yes",
  outcome: "Yes",
  title: "Will the Fed cut rates in September?",
};

const dipSpec: ChartSpec = { shape: "dip-recover", base: 0.52, amplitude: 0.1, markers: [] };
const dipSeries = makeSyntheticSeries(dipSpec, 11, WINDOW_END_MS);
const DIP_THRESHOLD = 0.47;
const DIP_STAKE_USD = 100;
const dipTriggers = [0.42, 0.5, 0.58].map((f) => {
  const pt = at(dipSeries, f);
  return { t: pt.t, price: pt.v };
});
const dipLast = dipSeries[dipSeries.length - 1]!.v;
const dipPnl = round2(
  dipTriggers.reduce(
    (sum, tr) => sum + (dipLast - tr.price) * Math.round(DIP_STAKE_USD / tr.price),
    0,
  ),
);

const dipDefinition: StrategyDefinition = {
  version: 2,
  name: `Dip-buy: ${dipRef.title}`,
  templateId: "re-entry",
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "c1",
        condition: {
          kind: "price",
          market: dipRef,
          source: "ask",
          comparator: "lte",
          threshold: DIP_THRESHOLD,
        },
      },
    ],
  },
  holdsForMs: 15 * 60_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: dipRef,
    side: "BUY",
    price: DIP_THRESHOLD,
    size: Math.round(DIP_STAKE_USD / DIP_THRESHOLD),
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

// ── Trailing stop ───────────────────────────────────────────────────────────

const stopRef: MarketRef = {
  conditionId: "sample-trailing-stop",
  tokenId: "sample-trailing-stop-yes",
  outcome: "Yes",
  title: "Will Team Spirit win the CS2 Major?",
};

const stopSpec: ChartSpec = { shape: "decline", base: 0.62, amplitude: 0.3, markers: [] };
const stopSeries = makeSyntheticSeries(stopSpec, 22, WINDOW_END_MS);
const stopExit = at(stopSeries, 0.52);
const stopLast = stopSeries[stopSeries.length - 1]!.v;
// "PnL" here is the crash damage the stop avoided on the 100-share position.
const stopPnl = round2((stopExit.v - stopLast) * 100);

const stopDefinition: StrategyDefinition = {
  version: 2,
  name: `Protect position: ${stopRef.title}`,
  templateId: "trailing-stop",
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "c1",
        condition: { kind: "trailing", market: stopRef, mode: "stop", source: "bid", offset: 0.09 },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: stopRef,
    side: "SELL",
    price: 0.5,
    size: 100,
    orderType: "FAK",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

// ── Maker range ─────────────────────────────────────────────────────────────

const makerRef: MarketRef = {
  conditionId: "sample-maker-range",
  tokenId: "sample-maker-range-yes",
  outcome: "Yes",
  title: "Will Spain win the 2026 World Cup?",
};

const makerSpec: ChartSpec = { shape: "range", base: 0.56, amplitude: 0.02, markers: [] };
const makerSeries = makeSyntheticSeries(makerSpec, 33, WINDOW_END_MS);
const makerFills = [0.2, 0.4, 0.6, 0.8].map((f) => {
  const pt = at(makerSeries, f);
  return { t: pt.t, price: pt.v };
});
// Two buy-low/sell-high round-trips of 200 shares inside the band.
const makerPnl = round2(
  (makerFills[1]!.price - makerFills[0]!.price + (makerFills[3]!.price - makerFills[2]!.price)) *
    200,
);

const makerDefinition: StrategyDefinition = {
  version: 2,
  name: `Maker range: ${makerRef.title}`,
  templateId: "maker-reward",
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "c1",
        condition: { kind: "spread", market: makerRef, comparator: "lte", threshold: 0.02 },
      },
      {
        type: "condition",
        id: "c2",
        condition: {
          kind: "cumulative_notional",
          market: makerRef,
          source: "ask",
          priceBound: 0.99,
          minNotional: 1000,
        },
      },
    ],
  },
  holdsForMs: 120_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: makerRef,
    side: "BUY",
    price: 0.55,
    size: 200,
    orderType: "GTC",
    postOnly: true,
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

export const FALLBACK_SHOWCASES: readonly FallbackShowcase[] = [
  {
    id: "sample-dip-buy",
    sample: true,
    market: {
      title: dipRef.title!,
      image: "",
      conditionId: dipRef.conditionId,
      tokenId: dipRef.tokenId,
      outcome: "Yes",
      currentPriceCents: Math.round(dipLast * 100),
    },
    sentence: `If Yes dips below 47¢ and holds 15 min → buy $${DIP_STAKE_USD} at 47¢`,
    prompt: `Buy $${DIP_STAKE_USD} of Yes on "${dipRef.title}" if the price dips to 47¢ and holds for 15 minutes`,
    definition: dipDefinition,
    stats: {
      stakeUsd: DIP_STAKE_USD,
      hypotheticalPnlUsd: dipPnl,
      triggerCount: dipTriggers.length,
      windowDays: WINDOW_DAYS,
    },
    series: toPricePoints(dipSeries),
    triggers: dipTriggers,
  },
  {
    id: "sample-trailing-stop",
    sample: true,
    market: {
      title: stopRef.title!,
      image: "",
      conditionId: stopRef.conditionId,
      tokenId: stopRef.tokenId,
      outcome: "Yes",
      currentPriceCents: Math.round(stopLast * 100),
    },
    sentence: `If Yes falls 9¢ from its peak → sell 100 shares at best price`,
    prompt: `I hold 100 Yes shares of "${stopRef.title}" — sell them if the price drops 9 cents from its high`,
    definition: stopDefinition,
    stats: {
      stakeUsd: 100,
      hypotheticalPnlUsd: stopPnl,
      triggerCount: 1,
      windowDays: WINDOW_DAYS,
    },
    series: toPricePoints(stopSeries),
    triggers: [{ t: stopExit.t, price: stopExit.v }],
  },
  {
    id: "sample-maker-range",
    sample: true,
    market: {
      title: makerRef.title!,
      image: "",
      conditionId: makerRef.conditionId,
      tokenId: makerRef.tokenId,
      outcome: "Yes",
      currentPriceCents: Math.round(makerSeries[makerSeries.length - 1]!.v * 100),
    },
    sentence: `While the spread stays under 2¢ → rest 200-share maker quotes around 55–58¢`,
    prompt: `When the spread on "${makerRef.title}" tightens under 2 cents with healthy liquidity, prepare a 200-share maker quote`,
    definition: makerDefinition,
    stats: {
      stakeUsd: 110,
      hypotheticalPnlUsd: makerPnl,
      triggerCount: makerFills.length,
      windowDays: WINDOW_DAYS,
    },
    series: toPricePoints(makerSeries),
    triggers: makerFills,
  },
];
