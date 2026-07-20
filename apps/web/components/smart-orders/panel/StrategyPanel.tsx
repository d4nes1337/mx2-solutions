"use client";

/**
 * Dashboard side panel: the full picture of one strategy without leaving the
 * page — annotated per-condition charts, live actuals, and quick edits of the
 * three numbers users actually tune (condition thresholds, limit price, size).
 * Edits are STAGED locally and applied through the supersede flow (definitions
 * are immutable): applying creates a new version, restarts the hold window,
 * and the panel follows the new id. Signing still happens only in
 * TriggerConfirm — this panel never submits an order.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, Star, X } from "lucide-react";
import { Badge, Button, Card, CardHeader, LiveDot, Skeleton, cn } from "@/components/ui";
import { fromCents, toCents } from "@/components/builder/editors/fields";
import { InlineNumber } from "./InlineNumber";
import { ConditionCharts } from "../detail/ConditionCharts";
import { conditionLeavesOf, docFromDefinition } from "@/lib/smart-orders/doc";
import { applyDefinitionEdits, type DefinitionEdits } from "@/lib/smart-orders/edit-definition";
import { conditionSummary, formatActual, cents } from "@/lib/smart-orders/summaries";
import { strategySentence, humanDuration } from "@/lib/smart-orders/sentence";
import { userStatus } from "@/lib/smart-orders/status";
import { useNow } from "@/lib/smart-orders/use-now";
import {
  useCreateStrategy,
  useStarStrategy,
  useStrategy,
  useStrategyControl,
  useStrategyEvaluation,
  useStrategyTimeline,
  type StrategyEvaluation,
  type StrategyRow,
} from "@/lib/smart-orders/queries";
import type { ConditionV2 } from "@mx2/rules";

const EDITABLE_STATUSES = ["ACTIVE_WAITING", "ACTIVE_ACCUMULATING", "PAUSED"];

/** Compact hold-window line (the detail page owns the full progress card). */
function DwellLine({ evaluation, now }: { evaluation: StrategyEvaluation; now: number }) {
  if (evaluation.trueSince === null || evaluation.holdsForMs <= 0) return null;
  const elapsed = Math.max(0, now - new Date(evaluation.trueSince).getTime());
  const pct = Math.min(100, (elapsed / evaluation.holdsForMs) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted">Conditions holding</span>
        <span className="tabular font-medium text-fg">
          {humanDuration(Math.min(elapsed, evaluation.holdsForMs))} of{" "}
          {humanDuration(evaluation.holdsForMs)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function StrategyPanel({
  id,
  fallbackRow,
  onClose,
  onFollow,
}: {
  id: string;
  /** List row shown while the detail query loads. */
  fallbackRow?: StrategyRow | undefined;
  onClose: () => void;
  /** Navigate the panel to another id (supersede follow). */
  onFollow: (id: string) => void;
}) {
  const strategy = useStrategy(id);
  const evaluation = useStrategyEvaluation(id);
  const timeline = useStrategyTimeline(id);
  const create = useCreateStrategy();
  const control = useStrategyControl();
  const star = useStarStrategy();
  const now = useNow();
  const [edits, setEdits] = useState<DefinitionEdits>({});

  // A new focus target starts from a clean slate.
  useEffect(() => {
    setEdits({});
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = strategy.data ?? fallbackRow;

  // Someone (another tab, a quick edit) replaced this version — follow it.
  const replacedBy = row?.supersededBy ?? null;
  useEffect(() => {
    if (replacedBy !== null) onFollow(replacedBy);
  }, [replacedBy, onFollow]);

  if (!row) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  const def = row.definitionV2;
  const doc = docFromDefinition(def);
  const status = userStatus(row.status, {
    actionKind: def.action.kind,
    execution: def.action.kind === "order" ? def.action.execution : undefined,
  });
  const editable = row.version === 2 && EDITABLE_STATUSES.includes(row.status);
  const starred = row.starredAt !== null;

  const stagedThreshold = (leafId: string, stored: number): number =>
    edits.thresholds?.[leafId] ?? stored;
  const stagedPrice = edits.orderPrice ?? (def.action.kind === "order" ? def.action.price : null);
  const stagedSize = edits.orderSize ?? (def.action.kind === "order" ? def.action.size : null);
  const dirty =
    Object.entries(edits.thresholds ?? {}).some(([leafId, v]) => {
      const leaf = conditionLeavesOf(doc.expr).find((l) => l.id === leafId);
      return leaf && leaf.condition.kind === "price" && leaf.condition.threshold !== v;
    }) ||
    (edits.orderPrice !== undefined &&
      def.action.kind === "order" &&
      edits.orderPrice !== def.action.price) ||
    (edits.orderSize !== undefined &&
      def.action.kind === "order" &&
      edits.orderSize !== def.action.size);

  const stageThreshold = (leafId: string, next: number) =>
    setEdits((prev) => ({
      ...prev,
      thresholds: { ...prev.thresholds, [leafId]: next },
    }));

  const apply = () => {
    create.mutate(
      { ...applyDefinitionEdits(def, edits), supersedes: row.id },
      {
        onSuccess: (created) => {
          setEdits({});
          onFollow(created.id);
        },
      },
    );
  };

  // Live actuals by leaf id (met / not yet / no data + "now X").
  const results = new Map<string, { satisfied: boolean; stale: boolean; actual: number | null }>();
  const walk = (node: NonNullable<StrategyEvaluation["root"]>): void => {
    if (node.type === "condition") {
      results.set(node.id, {
        satisfied: node.satisfied,
        stale: node.result.stale,
        actual: node.result.actual,
      });
    } else {
      node.children.forEach(walk);
    }
  };
  if (evaluation.data?.root) walk(evaluation.data.root);

  const leaves = conditionLeavesOf(doc.expr);

  const thresholdChip = (leafId: string, c: ConditionV2) => {
    if (c.kind === "price") {
      const staged = stagedThreshold(leafId, c.threshold);
      return (
        <span className="flex items-center gap-1 text-[11px] text-muted">
          trigger{" "}
          <InlineNumber
            label="Trigger price"
            display={cents(staged)}
            value={toCents(staged)}
            min={1}
            max={99}
            suffix="¢"
            dirty={staged !== c.threshold}
            disabled={!editable}
            onCommit={(v) => stageThreshold(leafId, fromCents(v))}
          />
        </span>
      );
    }
    if (c.kind === "trailing") {
      return (
        <span className="tabular text-[11px] text-muted">
          trailing {c.mode} · {cents(c.offset)} offset
        </span>
      );
    }
    if (c.kind === "price_move") {
      return (
        <span className="tabular text-[11px] text-muted">
          {c.direction} {cents(c.deltaThreshold)} in {humanDuration(c.windowMs)}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-panel">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={starred ? "Unstar strategy" : "Star strategy"}
              aria-pressed={starred}
              disabled={star.isPending}
              onClick={() => star.mutate({ id: row.id, starred: !starred })}
              className={cn(
                "transition-colors",
                starred ? "text-warn" : "text-faint hover:text-muted",
              )}
            >
              <Star size={14} aria-hidden fill={starred ? "currentColor" : "none"} />
            </button>
            <h2 className="truncate text-[15px] font-semibold text-fg">
              {row.name || def.name || "Smart Order"}
            </h2>
            {status.live ? (
              <LiveDot
                label={status.label.toUpperCase()}
                tone={status.tone === "neg" ? "neg" : status.tone === "warn" ? "warn" : "pos"}
              />
            ) : (
              <Badge tone={status.tone}>{status.label}</Badge>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{strategySentence(doc)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/smart-orders/${row.id}`}
            title="Open the full page (timeline, orders, history)"
            className="rounded-md p-1 text-muted transition-colors hover:text-fg"
          >
            <ExternalLink size={14} aria-hidden />
          </Link>
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="rounded-md p-1 text-muted transition-colors hover:text-fg"
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        {status.group === "monitoring" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={control.isPending}
            onClick={() => control.mutate({ id: row.id, action: "pause" })}
          >
            Pause
          </Button>
        ) : null}
        {row.status === "PAUSED" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={control.isPending}
            onClick={() => control.mutate({ id: row.id, action: "resume" })}
          >
            Resume
          </Button>
        ) : null}
        {status.group === "monitoring" || row.status === "PAUSED" ? (
          <Button
            variant="danger"
            size="sm"
            disabled={control.isPending}
            onClick={() => control.mutate({ id: row.id, action: "cancel" })}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {evaluation.data ? <DwellLine evaluation={evaluation.data} now={now} /> : null}

      {/* Conditions: text + live actuals + inline threshold edits */}
      <Card>
        <CardHeader>Conditions</CardHeader>
        <div className="divide-y divide-border">
          {leaves.map(({ id: leafId, condition: c }) => {
            const r = results.get(leafId);
            const { summary, detail } = conditionSummary(doc, c);
            const actual = r ? formatActual(c.kind, r.actual) : null;
            return (
              <div key={leafId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-fg">{summary}</div>
                  {detail ? <div className="truncate text-[10px] text-faint">{detail}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.kind === "price" ? thresholdChip(leafId, c) : null}
                  {actual !== null ? (
                    <span className="tabular text-[11px] text-muted">now {actual}</span>
                  ) : null}
                  {!r ? (
                    <Badge tone="neutral">—</Badge>
                  ) : r.stale ? (
                    <Badge tone="warn">no data</Badge>
                  ) : r.satisfied ? (
                    <Badge tone="pos">met</Badge>
                  ) : (
                    <Badge tone="neutral">not yet</Badge>
                  )}
                </div>
              </div>
            );
          })}
          {leaves.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted">No conditions.</div>
          ) : null}
        </div>
      </Card>

      {/* Order: side/size/price with inline edits */}
      {def.action.kind === "order" && stagedPrice !== null && stagedSize !== null ? (
        <Card>
          <CardHeader>Order</CardHeader>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-[12px] text-fg">
            <span
              className={
                def.action.side === "BUY" ? "font-semibold text-pos" : "font-semibold text-neg"
              }
            >
              {def.action.side}
            </span>
            <InlineNumber
              label="Order size"
              display={`${stagedSize} shares`}
              value={stagedSize}
              min={1}
              max={1_000_000}
              suffix="shares"
              dirty={stagedSize !== def.action.size}
              disabled={!editable}
              onCommit={(v) => setEdits((prev) => ({ ...prev, orderSize: v }))}
            />
            <span className="text-muted">at</span>
            <InlineNumber
              label="Limit price"
              display={cents(stagedPrice)}
              value={toCents(stagedPrice)}
              min={1}
              max={99}
              suffix="¢"
              dirty={stagedPrice !== def.action.price}
              disabled={!editable}
              onCommit={(v) => setEdits((prev) => ({ ...prev, orderPrice: fromCents(v) }))}
            />
            <span className="text-muted">
              · {def.action.orderType}
              {def.action.execution === "auto" ? " · auto" : " · ask to sign"}
            </span>
          </div>
        </Card>
      ) : null}

      {/* Charts: threshold lines preview staged edits live */}
      <ConditionCharts
        row={row}
        timeline={timeline.data}
        height={150}
        thresholds={edits.thresholds}
        renderThreshold={thresholdChip}
      />

      {row.supersedes !== null ? (
        <p className="text-[10px] text-faint">
          This version replaced an earlier one — spend caps and pins carried over.
        </p>
      ) : null}

      {/* Sticky apply bar (staged edits → supersede) */}
      {dirty ? (
        <div className="sticky bottom-0 -mx-4 -mb-4 space-y-2 rounded-b-xl border-t border-border bg-surface-2 p-3">
          <p className="text-[11px] leading-snug text-warn">
            Applying re-arms the strategy as a new version — the hold window restarts.
          </p>
          {create.error ? (
            <p className="text-[11px] text-neg">{(create.error as Error).message}</p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={create.isPending}
              onClick={() => setEdits({})}
            >
              Discard
            </Button>
            <Button variant="primary" size="sm" disabled={create.isPending} onClick={apply}>
              {create.isPending ? "Applying…" : "Apply changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
