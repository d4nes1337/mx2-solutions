"use client";

/**
 * Live market binding for a hero demo scenario (Slice 5): smart-search the
 * scenario's marketQuery, take the top hit, pull its recent price history.
 * Anything short of a full, healthy series degrades to {status:"synthetic"}
 * — the caller falls back to makeSyntheticSeries with an "illustrative"
 * caption. Never throws.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useTokenPricesHistory } from "../queries";
import type { MarketSearchResult } from "../strategies/queries";
import type { ChartPoint } from "@/components/charts/AreaChart";
import type { DemoScenario } from "./demo-scenarios";

export type ScenarioBinding =
  | { status: "live"; title: string; series: ChartPoint[]; priceCents: number }
  | { status: "synthetic" };

const STALE_MS = 5 * 60_000;
/** Fewer points than this charts badly — treat as no data. */
const MIN_LIVE_POINTS = 8;

export function useScenarioBinding(scenario: DemoScenario, enabled = true): ScenarioBinding {
  const q = scenario.marketQuery.trim();

  const search = useQuery({
    queryKey: ["home-demo-search", q],
    queryFn: () =>
      api.get<{ results: MarketSearchResult[] }>(`/api/markets/search?q=${encodeURIComponent(q)}`),
    enabled: enabled && q.length >= 2,
    staleTime: STALE_MS,
    retry: 1,
  });

  const hit = search.data?.results[0] ?? null;
  const tokenId = hit?.tokenIds[0] ?? null;

  // Shared chart hook: same interval→fidelity mapping (1w → 15-min candles)
  // and 10s poll as every other chart surface, plus a shared cache key with
  // any market page already watching this token.
  const history = useTokenPricesHistory(enabled ? tokenId : null, "1w");

  if (!hit || !tokenId || !history.data) return { status: "synthetic" };

  const series: ChartPoint[] = history.data.history.map((p) => ({ t: p.t, v: p.p }));
  if (series.length < MIN_LIVE_POINTS) return { status: "synthetic" };

  const yesPrice = Number(hit.outcomePrices[0]);
  const last = series[series.length - 1]!.v;
  const priceCents = Math.round(
    (Number.isFinite(yesPrice) && yesPrice > 0 ? yesPrice : last) * 100,
  );

  return { status: "live", title: hit.title, series, priceCents };
}
