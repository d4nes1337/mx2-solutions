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
import type { MarketFreshness, StrategyTimeline } from "@/lib/strategies/queries";
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
  liveReceivedAtMs,
  timeline,
  onOpenCanvas,
  edit = false,
  actFooter,
  onDuplicateForMarket,
}: {
  doc: StrategyDoc;
  /** Live per-condition readings + per-token book quotes (strategy or draft evaluation). */
  evaluation?: { root: ExprResultNode | null; markets?: MarketFreshness[] } | undefined;
  /** Client-clock time the evaluation landed (query.dataUpdatedAt) — ages the captions. */
  liveReceivedAtMs?: number | undefined;
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
  /**
   * ONE sheet at a time. Independent booleans let two dialogs mount together
   * and overlap into an unreadable stack; a single tagged value makes that
   * impossible.
   */
  const [sheet, setSheet] = useState<
    { kind: "row"; nodeId: string } | { kind: "action" } | { kind: "settings" } | null
  >(null);

  const addCondition = useBuilderStore((s) => s.addCondition);
  const setCardOp = useBuilderStore((s) => s.setCardOp);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const select = useBuilderStore((s) => s.select);
  const removeWatchedMarket = useBuilderStore((s) => s.removeWatchedMarket);
  const lastAiChangedIds = useBuilderStore((s) => s.lastAiChangedIds);
  const selectedNodeId = useBuilderStore((s) => s.doc.selectedNodeId);

  const closeSheet = () => setSheet(null);
  /** Selecting the node keeps the canvas in sync with what's being edited. */
  const openRow = (nodeId: string) => {
    select(nodeId);
    setSheet({ kind: "row", nodeId });
  };

  const projection = docToGrid(doc);
  const results = collectConditionResults(evaluation?.root);
  const liveByToken = new Map((evaluation?.markets ?? []).map((m) => [m.tokenId, m]));
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

  // The AI-changed flash is a cue, not a state: without this the touched rows
  // pulse for the rest of the session.
  const clearAiChanged = useBuilderStore((s) => s.clearAiChanged);
  useEffect(() => {
    if (lastAiChangedIds.length === 0) return;
    const t = setTimeout(clearAiChanged, 6_000);
    return () => clearTimeout(t);
  }, [lastAiChangedIds, clearAiChanged]);

  // Deleting the condition from inside its editor would leave an empty sheet
  // pointing at a node that no longer exists.
  const rowNodeGone =
    sheet?.kind === "row" &&
    !projection.watch.some((c) => c.rows.some((r) => r.nodeId === sheet.nodeId));
  useEffect(() => {
    if (rowNodeGone) setSheet(null);
  }, [rowNodeGone]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Segmented options={CHART_RANGES} value={range} onChange={setRange} size="sm" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,11fr)_auto_minmax(0,9fr)]">
        {/* WATCH zone */}
        <div className="min-w-0 space-y-2">
          {/* Always present in edit mode: it labels the zone, so a blank
              builder isn't an unlabelled column facing a labelled THEN. */}
          {edit || projection.watch.length > 0 ? (
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
                  live={liveByToken.get(card.key)}
                  liveReceivedAtMs={liveReceivedAtMs}
                  range={range}
                  markers={markers}
                  highlightIds={highlightIds}
                  isTarget={projection.targetTokenId === card.key}
                  selected={selection.cardKey === card.key}
                  onSelect={edit ? () => select(`market:${card.key}`) : undefined}
                  edit={
                    edit
                      ? {
                          onEditRow: openRow,
                          onAddCondition: () => {
                            const id = addCondition(
                              defaultCondition(
                                card.key === "time" ? "time_window" : "price",
                                card.market ?? UNBOUND,
                              ),
                              card.opNodeId ?? undefined,
                            );
                            openRow(id);
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
          edit={edit ? { onOpenSettings: () => setSheet({ kind: "settings" }) } : undefined}
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
              live={
                doc.action.kind === "order" ? liveByToken.get(doc.action.market.tokenId) : undefined
              }
              liveReceivedAtMs={liveReceivedAtMs}
              range={range}
              markers={markers}
              selected={selection.action}
              edit={
                edit
                  ? {
                      onEditAction: () => {
                        select("action");
                        setSheet({ kind: "action" });
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
          <RowEditorSheet
            nodeId={sheet?.kind === "row" ? sheet.nodeId : null}
            onClose={closeSheet}
          />
          <SheetPanel
            open={sheet?.kind === "action"}
            onClose={closeSheet}
            title="Edit the action"
            description="What arima does the moment your conditions hold."
          >
            <ActionEditor />
          </SheetPanel>
          <SheetPanel
            open={sheet?.kind === "settings"}
            onClose={closeSheet}
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
