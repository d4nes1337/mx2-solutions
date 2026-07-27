"use client";

/**
 * The grid projection of a strategy (ADR-0010: a second pure view over the
 * StrategyDoc, beside the canvas): WATCH zone (per-market cards with charts +
 * live condition states, under one IF header carrying the root combinator) →
 * spine (direction + hold window) → ACT zone (the order, dollars-first).
 * View mode renders an armed strategy read-only on the detail page; edit mode
 * (builder) drives the SAME store-bound editors the canvas uses, in sheets.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Segmented } from "@/components/ui";
import { SheetPanel } from "@/components/ui/SheetPanel";
import { UNBOUND, type StrategyDoc } from "@/lib/strategies/doc";
import {
  collectConditionResults,
  docToGrid,
  selectionTarget,
} from "@/lib/strategies/grid-projection";
import { useBuilderStore } from "@/lib/strategies/store";
import type { StrategyTimeline } from "@/lib/strategies/queries";
import type { ExprResultNode } from "@mx2/rules";
import { timelineMarkers } from "@/components/strategies/detail/ConditionCharts";
import { defaultCondition } from "@/components/builder/editors/ConditionEditor";
import { ActionEditor } from "@/components/builder/editors/ActionEditor";
import { StrategySettingsFields } from "@/components/builder/StrategySettings";
import { WatchMarketCard } from "./WatchMarketCard";
import { IfZoneHeader } from "./IfZoneHeader";
import { LogicSpine } from "./LogicSpine";
import { ActTargetCard } from "./ActTargetCard";
import { ComplexLogicStrip } from "./ComplexLogicStrip";
import { AddMarketBar } from "./AddMarketBar";
import { RowEditorSheet } from "./RowEditorSheet";

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
  edit = false,
  actFooter,
  onDuplicateForMarket,
}: {
  doc: StrategyDoc;
  /** Live per-condition readings (strategy or draft evaluation). */
  evaluation?: { root: ExprResultNode | null } | undefined;
  timeline?: StrategyTimeline | undefined;
  /** Builder only: reveal/expand the canvas (complex-logic escape hatch). */
  onOpenCanvas?: (() => void) | undefined;
  /** Builder: mount the store-bound edit affordances. */
  edit?: boolean;
  /** Builder: rendered under the ACT column (save/arm card). */
  actFooter?: ReactNode;
  /** Builder: clone the strategy to trade a second market on the same logic. */
  onDuplicateForMarket?: (() => void) | undefined;
}) {
  const [range, setRange] = useState("1d");
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const addCondition = useBuilderStore((s) => s.addCondition);
  const setCardOp = useBuilderStore((s) => s.setCardOp);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const select = useBuilderStore((s) => s.select);
  const removeWatchedMarket = useBuilderStore((s) => s.removeWatchedMarket);
  const lastAiChangedIds = useBuilderStore((s) => s.lastAiChangedIds);
  const selectedNodeId = useBuilderStore((s) => s.doc.selectedNodeId);

  const projection = docToGrid(doc);
  const results = collectConditionResults(evaluation?.root);
  const markers = timelineMarkers(timeline);
  const highlightIds = edit && lastAiChangedIds.length > 0 ? new Set(lastAiChangedIds) : undefined;
  const selection = edit
    ? selectionTarget(projection, selectedNodeId)
    : { cardKey: null, action: false };

  // A canvas click scrolls its grid counterpart into view — the two views
  // stay legible together instead of the highlight landing off-screen.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selection.cardKey && !selection.action) return;
    selectedRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selection.cardKey, selection.action]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Segmented options={CHART_RANGES} value={range} onChange={setRange} size="sm" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,11fr)_auto_minmax(0,9fr)]">
        {/* WATCH zone */}
        <div className="min-w-0 space-y-2">
          {projection.watch.length > 0 ? (
            <IfZoneHeader
              rootOp={projection.rootOp}
              cardCount={projection.watch.length}
              onSetRootOp={edit ? setRootOp : undefined}
            />
          ) : null}
          <div className="space-y-3">
            {projection.watch.map((card) => (
              <div key={card.key} ref={selection.cardKey === card.key ? selectedRef : undefined}>
                <WatchMarketCard
                  doc={doc}
                  card={card}
                  results={results}
                  range={range}
                  markers={markers}
                  highlightIds={highlightIds}
                  isTarget={projection.targetTokenId === card.key}
                  selected={selection.cardKey === card.key}
                  onSelect={edit ? () => select(`market:${card.key}`) : undefined}
                  edit={
                    edit
                      ? {
                          onEditRow: (nodeId) => {
                            select(nodeId);
                            setEditingNode(nodeId);
                          },
                          onAddCondition: () => {
                            const id = addCondition(
                              defaultCondition(
                                card.key === "time" ? "time_window" : "price",
                                card.market ?? UNBOUND,
                              ),
                              card.opNodeId ?? undefined,
                            );
                            setEditingNode(id);
                          },
                          onSetOp: (op) => setCardOp(card.key, op),
                          onRemove:
                            card.placeholder && card.market
                              ? () => removeWatchedMarket(card.market!.tokenId)
                              : undefined,
                        }
                      : undefined
                  }
                />
              </div>
            ))}
            <ComplexLogicStrip doc={doc} complex={projection.complex} onOpenCanvas={onOpenCanvas} />
            {edit ? (
              <AddMarketBar />
            ) : projection.watch.length === 0 && projection.complex.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted">
                No watched markets — this strategy has no conditions.
              </div>
            ) : null}
          </div>
        </div>

        {/* Spine */}
        <LogicSpine
          holdsForMs={doc.holdsForMs}
          edit={edit ? { onOpenSettings: () => setSettingsOpen(true) } : undefined}
        />

        {/* ACT zone */}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 px-0.5">
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-accent">
              Then
            </span>
            <span className="text-[12px] text-muted">arima does this — once, for you</span>
          </div>
          <div ref={selection.action ? selectedRef : undefined}>
            <ActTargetCard
              doc={doc}
              range={range}
              markers={markers}
              selected={selection.action}
              edit={
                edit
                  ? {
                      onEditAction: () => {
                        select("action");
                        setActionOpen(true);
                      },
                      onDuplicateForMarket,
                    }
                  : undefined
              }
            />
          </div>
          {actFooter}
        </div>
      </div>

      {edit ? (
        <>
          <RowEditorSheet nodeId={editingNode} onClose={() => setEditingNode(null)} />
          <SheetPanel
            open={actionOpen}
            onClose={() => setActionOpen(false)}
            title="Edit the action"
            description="What arima does the moment your conditions hold."
          >
            <ActionEditor />
          </SheetPanel>
          <SheetPanel
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            title="Strategy settings"
            description="Hold window, repeats and expiry."
          >
            <StrategySettingsFields />
          </SheetPanel>
        </>
      ) : null}
    </div>
  );
}
