"use client";

/**
 * Right side of the hero (Slice 5): the strategy the demo chat is "typing",
 * assembled live. Condition → logic → action chips reveal in lockstep with
 * the typer (both derive from the same player state), the chart binds to a
 * real market when the smart search finds one, and falls back to the
 * deterministic synthetic series with an "illustrative" caption (R-023).
 */
import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, LiveDot } from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { api } from "@/lib/api";
import type { MarketSearchResult } from "@/lib/smart-orders/queries";
import type { ScenarioBinding } from "@/lib/home/use-scenario-binding";
import {
  makeSyntheticSeries,
  type DemoScenario,
  type DiagramChip,
} from "@/lib/home/demo-scenarios";
import { Chip } from "./ShowcaseCard";

/** Quantized to the hour so SSR and client render the same synthetic series. */
const SYNTHETIC_END_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/** Deterministic per-scenario seed — same id, same synthetic chart. */
const seedFor = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h || 1;
};

const chipTone = (chip: DiagramChip): string => {
  if (chip.role === "condition") return "brand";
  if (chip.role === "action") return /sell/i.test(chip.label) ? "neg" : "pos";
  return "neutral";
};

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

export function StrategyPreviewPanel({
  scenario,
  revealedChips,
  showMarkers,
  binding,
  idx,
  count,
  goTo,
}: {
  scenario: DemoScenario;
  revealedChips: DiagramChip[];
  showMarkers: boolean;
  binding: ScenarioBinding;
  idx: number;
  count: number;
  goTo: (i: number) => void;
}) {
  // The binding hook exposes title/series only; reuse its cached search entry
  // (identical queryKey + fn → served from cache, no second request) to
  // recover the conditionId the ?pinned= deep link needs.
  const q = scenario.marketQuery.trim();
  const peek = useQuery({
    queryKey: ["home-demo-search", q],
    queryFn: () =>
      api.get<{ results: MarketSearchResult[] }>(`/api/markets/search?q=${encodeURIComponent(q)}`),
    enabled: binding.status === "live" && q.length >= 2,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const bound = peek.data?.results[0] ?? null;

  const series = useMemo<ChartPoint[]>(
    () =>
      binding.status === "live"
        ? binding.series
        : makeSyntheticSeries(scenario.chart, seedFor(scenario.id), SYNTHETIC_END_MS),
    [binding, scenario],
  );

  const markers = useMemo(
    () =>
      series.length < 2
        ? []
        : scenario.chart.markers.map((m) => ({
            t: series[Math.round(m.atFrac * (series.length - 1))]!.t,
            label: m.label,
          })),
    [series, scenario],
  );

  const slotText = scenario.prompt.find((seg) => seg.isMarketSlot)?.text ?? scenario.title;
  const marketName = binding.status === "live" ? binding.title : slotText.replace(/^@/, "");
  const href =
    `/smart-orders/new?prompt=${encodeURIComponent(scenario.buildPrompt)}` +
    (binding.status === "live" && bound
      ? `&pinned=${bound.conditionId}~${encodeURIComponent(binding.title.slice(0, 60))}`
      : "");

  return (
    <div className="glass space-y-3 rounded-xl p-5 shadow-elev">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Demo · {scenario.title}
        </span>
        {binding.status === "live" ? <LiveDot label="LIVE MARKET" /> : <Badge>Illustrative</Badge>}
      </div>

      {/* Chips assemble in lockstep with the typer — same player state. */}
      <div className="flex min-h-[64px] flex-wrap content-start items-center gap-1.5 leading-relaxed">
        {revealedChips.map((chip) => (
          <span key={`${scenario.id}-${chip.role}-${chip.appearAt}`} className="fade-in">
            <Chip tone={chipTone(chip)}>
              {chip.label.replace("{market}", truncate(marketName, 28))}
            </Chip>
          </span>
        ))}
      </div>

      <AreaChart
        data={series}
        height={120}
        showAxis={false}
        markers={showMarkers ? markers : []}
        valueFormat={(v) => `${Math.round(v * 100)}¢`}
      />
      {binding.status === "synthetic" ? (
        <p className="text-[10px] leading-snug text-faint">
          Illustrative price path — synthetic data, not a live market.
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2">
        <span className="min-w-0">
          <span className="line-clamp-1 text-[12px] font-medium text-fg">{marketName}</span>
          {binding.status === "live" ? (
            <span className="tabular text-[11px] text-muted">{binding.priceCents}¢ now</span>
          ) : null}
        </span>
        <Link
          href={href}
          className="shrink-0 text-[12px] font-semibold text-accent hover:text-brand-strong"
        >
          Build this →
        </Link>
      </div>

      {count > 1 ? (
        <div className="flex items-center justify-center gap-1.5">
          {Array.from({ length: count }).map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show demo ${i + 1} of ${count}`}
              aria-current={i === idx}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? "w-5 bg-brand" : "w-1.5 bg-border-strong hover:bg-muted"
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
