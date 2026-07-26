"use client";

/**
 * The grid projection of a strategy (ADR-0010: a second pure view over the
 * StrategyDoc, beside the canvas): WATCH zone (per-market cards with charts +
 * live condition states) → IF spine (root ALL/ANY + hold window) → ACT zone
 * (the target market and its order, dollars-first). View mode renders an
 * armed strategy read-only on the detail page; edit mode (builder) mounts on
 * top of the same layout.
 */
import { useState } from "react";
import { Segmented } from "@/components/ui";
import type { StrategyDoc } from "@/lib/strategies/doc";
import { collectConditionResults, docToGrid } from "@/lib/strategies/grid-projection";
import type { StrategyEvaluation, StrategyTimeline } from "@/lib/strategies/queries";
import { timelineMarkers } from "@/components/strategies/detail/ConditionCharts";
import { WatchMarketCard } from "./WatchMarketCard";
import { LogicSpine } from "./LogicSpine";
import { ActTargetCard } from "./ActTargetCard";
import { ComplexLogicStrip } from "./ComplexLogicStrip";

const CHART_RANGES = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
];

export function StrategyGrid({
  doc,
  evaluation,
  timeline,
  onOpenCanvas,
}: {
  doc: StrategyDoc;
  evaluation?: StrategyEvaluation | undefined;
  timeline?: StrategyTimeline | undefined;
  /** Builder only: jump to the canvas view (complex-logic escape hatch). */
  onOpenCanvas?: (() => void) | undefined;
}) {
  const [range, setRange] = useState("1d");
  const projection = docToGrid(doc);
  const results = collectConditionResults(evaluation?.root);
  const markers = timelineMarkers(timeline);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Segmented options={CHART_RANGES} value={range} onChange={setRange} size="sm" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,11fr)_auto_minmax(0,9fr)]">
        {/* WATCH zone */}
        <div className="min-w-0 space-y-3">
          {projection.watch.map((card) => (
            <WatchMarketCard
              key={card.key}
              doc={doc}
              card={card}
              results={results}
              range={range}
              markers={markers}
            />
          ))}
          <ComplexLogicStrip doc={doc} complex={projection.complex} onOpenCanvas={onOpenCanvas} />
          {projection.watch.length === 0 && projection.complex.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted">
              No watched markets — this strategy has no conditions yet.
            </div>
          ) : null}
        </div>

        {/* IF spine */}
        <LogicSpine rootOp={projection.rootOp} holdsForMs={doc.holdsForMs} />

        {/* ACT zone */}
        <div className="min-w-0 space-y-3">
          <ActTargetCard
            doc={doc}
            guards={projection.guards}
            guardsOp={projection.guardsOp}
            results={results}
            range={range}
            markers={markers}
          />
        </div>
      </div>
    </div>
  );
}
