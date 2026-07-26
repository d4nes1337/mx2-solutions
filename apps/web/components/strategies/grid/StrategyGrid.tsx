"use client";

/**
 * The grid projection of a strategy (ADR-0010: a second pure view over the
 * StrategyDoc, beside the canvas): WATCH zone (per-market cards with charts +
 * live condition states) → IF spine (root ALL/ANY + hold window) → ACT zone
 * (the target market and its order, dollars-first). View mode renders an
 * armed strategy read-only on the detail page; edit mode (builder) drives
 * the SAME store-bound editors the canvas uses, through sheets.
 */
import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Segmented } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { UNBOUND, type StrategyDoc } from "@/lib/strategies/doc";
import { collectConditionResults, docToGrid } from "@/lib/strategies/grid-projection";
import { useBuilderStore } from "@/lib/strategies/store";
import type { StrategyTimeline } from "@/lib/strategies/queries";
import type { ExprResultNode } from "@mx2/rules";
import { timelineMarkers } from "@/components/strategies/detail/ConditionCharts";
import { defaultCondition } from "@/components/builder/editors/ConditionEditor";
import { ActionEditor } from "@/components/builder/editors/ActionEditor";
import { StrategySettings } from "@/components/builder/StrategySettings";
import { WatchMarketCard } from "./WatchMarketCard";
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

function EditorSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <SheetShell open={open} onClose={onClose} label={title}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-muted transition-colors hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
    </SheetShell>
  );
}

export function StrategyGrid({
  doc,
  evaluation,
  timeline,
  onOpenCanvas,
  edit = false,
  actFooter,
}: {
  doc: StrategyDoc;
  /** Live per-condition readings (strategy or draft evaluation). */
  evaluation?: { root: ExprResultNode | null } | undefined;
  timeline?: StrategyTimeline | undefined;
  /** Builder only: jump to the canvas view (complex-logic escape hatch). */
  onOpenCanvas?: (() => void) | undefined;
  /** Builder: mount the store-bound edit affordances. */
  edit?: boolean;
  /** Builder: rendered under the ACT column (save/arm card). */
  actFooter?: ReactNode;
}) {
  const [range, setRange] = useState("1d");
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const addCondition = useBuilderStore((s) => s.addCondition);
  const setCardOp = useBuilderStore((s) => s.setCardOp);
  const setRootOp = useBuilderStore((s) => s.setRootOp);
  const removeWatchedMarket = useBuilderStore((s) => s.removeWatchedMarket);
  const lastAiChangedIds = useBuilderStore((s) => s.lastAiChangedIds);

  const projection = docToGrid(doc);
  const results = collectConditionResults(evaluation?.root);
  const markers = timelineMarkers(timeline);
  const highlightIds = edit && lastAiChangedIds.length > 0 ? new Set(lastAiChangedIds) : undefined;

  return (
    <div className="space-y-3" data-tour="builder-canvas">
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
              highlightIds={highlightIds}
              edit={
                edit
                  ? {
                      onEditRow: setEditingNode,
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

        {/* IF spine */}
        <LogicSpine
          rootOp={projection.rootOp}
          holdsForMs={doc.holdsForMs}
          edit={
            edit
              ? { onSetRootOp: setRootOp, onOpenSettings: () => setSettingsOpen(true) }
              : undefined
          }
        />

        {/* ACT zone */}
        <div className="min-w-0 space-y-3">
          <ActTargetCard
            doc={doc}
            guards={projection.guards}
            guardsOp={projection.guardsOp}
            results={results}
            range={range}
            markers={markers}
            highlightIds={highlightIds}
            edit={
              edit
                ? {
                    onEditAction: () => setActionOpen(true),
                    onAddGuard: () => {
                      if (doc.action.kind !== "order") return;
                      const id = addCondition(defaultCondition("price", doc.action.market));
                      setEditingNode(id);
                    },
                    onEditRow: setEditingNode,
                    onSetGuardsOp: (op) => {
                      if (doc.action.kind === "order") setCardOp(doc.action.market.tokenId, op);
                    },
                  }
                : undefined
            }
          />
          {actFooter}
        </div>
      </div>

      {edit ? (
        <>
          <RowEditorSheet nodeId={editingNode} onClose={() => setEditingNode(null)} />
          <EditorSheet
            open={actionOpen}
            onClose={() => setActionOpen(false)}
            title="Edit the action"
          >
            <ActionEditor />
          </EditorSheet>
          <EditorSheet
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            title="Strategy settings"
          >
            <StrategySettings />
          </EditorSheet>
        </>
      ) : null}
    </div>
  );
}
