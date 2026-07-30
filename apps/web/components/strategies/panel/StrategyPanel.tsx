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
import { RenameField } from "../RenameField";
import { MetaRow } from "../MetaRow";
import { TagsRow } from "../TagsRow";
import { ConditionCharts } from "../detail/ConditionCharts";
import { conditionLeavesOf, docFromDefinition } from "@/lib/strategies/doc";
import { applyDefinitionEdits, type DefinitionEdits } from "@/lib/strategies/edit-definition";
import { conditionSummary, formatActual, cents } from "@/lib/strategies/summaries";
import { strategySentence, humanDuration } from "@/lib/strategies/sentence";
import { userStatus } from "@/lib/strategies/status";
import { useNow } from "@/lib/strategies/use-now";
import {
  useCreateStrategy,
  useStarStrategy,
  useStrategy,
  useStrategyControl,
  useStrategyEvaluation,
  useStrategyTimeline,
  type StrategyEvaluation,
  type StrategyRow,
} from "@/lib/strategies/queries";
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

  /** Stage one number into any of the per-condition maps. */
  const stageIn = (
    map: "thresholds" | "offsets" | "deltas" | "windows" | "minNotionals" | "minLevels",
    leafId: string,
    next: number,
  ) => setEdits((prev) => ({ ...prev, [map]: { ...prev[map], [leafId]: next } }));
  const stagedHold = edits.holdsForMs ?? def.holdsForMs;
  const stagedPrice = edits.orderPrice ?? (def.action.kind === "order" ? def.action.price : null);
  const stagedSize = edits.orderSize ?? (def.action.kind === "order" ? def.action.size : null);
  /** Stored value for a staged number, so "dirty" compares like with like. */
  const storedOf = (leafId: string, map: keyof DefinitionEdits): number | null => {
    const leaf = conditionLeavesOf(doc.expr).find((l) => l.id === leafId);
    const c = leaf?.condition;
    if (!c) return null;
    if (map === "thresholds") return c.kind === "price" || c.kind === "spread" ? c.threshold : null;
    if (map === "offsets") return c.kind === "trailing" ? c.offset : null;
    if (map === "deltas") return c.kind === "price_move" ? c.deltaThreshold : null;
    if (map === "windows") return c.kind === "price_move" ? c.windowMs : null;
    if (map === "minNotionals") return c.kind === "cumulative_notional" ? c.minNotional : null;
    if (map === "minLevels") return c.kind === "visible_levels" ? c.minLevels : null;
    return null;
  };
  const CONDITION_MAPS = [
    "thresholds",
    "offsets",
    "deltas",
    "windows",
    "minNotionals",
    "minLevels",
  ] as const;
  const dirty =
    CONDITION_MAPS.some((map) =>
      Object.entries(edits[map] ?? {}).some(([leafId, v]) => storedOf(leafId, map) !== v),
    ) ||
    (edits.orderPrice !== undefined &&
      def.action.kind === "order" &&
      edits.orderPrice !== def.action.price) ||
    (edits.orderSize !== undefined &&
      def.action.kind === "order" &&
      edits.orderSize !== def.action.size) ||
    (edits.holdsForMs !== undefined && edits.holdsForMs !== def.holdsForMs);

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

  /**
   * The editable number(s) for ONE condition — every joint is tunable here, and
   * each kind exposes only the number that actually matters for it. Read-only
   * strategies (or v1 rows) render the same chips disabled, so the panel looks
   * identical whether or not editing is allowed.
   */
  const thresholdChip = (leafId: string, c: ConditionV2) => {
    const common = { disabled: !editable } as const;
    switch (c.kind) {
      case "price":
      case "spread": {
        const staged = edits.thresholds?.[leafId] ?? c.threshold;
        return (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            {c.kind === "spread" ? "spread" : "trigger"}{" "}
            <InlineNumber
              {...common}
              label={c.kind === "spread" ? "Spread threshold" : "Trigger price"}
              display={cents(staged)}
              value={toCents(staged)}
              min={1}
              max={99}
              suffix="¢"
              dirty={staged !== c.threshold}
              onCommit={(v) => stageIn("thresholds", leafId, fromCents(v))}
            />
          </span>
        );
      }
      case "trailing": {
        const staged = edits.offsets?.[leafId] ?? c.offset;
        return (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            {c.mode} by{" "}
            <InlineNumber
              {...common}
              label="Trailing offset"
              display={cents(staged)}
              value={toCents(staged)}
              min={1}
              max={50}
              suffix="¢"
              dirty={staged !== c.offset}
              onCommit={(v) => stageIn("offsets", leafId, fromCents(v))}
            />
          </span>
        );
      }
      case "price_move": {
        const delta = edits.deltas?.[leafId] ?? c.deltaThreshold;
        const window = edits.windows?.[leafId] ?? c.windowMs;
        return (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            {c.direction}{" "}
            <InlineNumber
              {...common}
              label="Move size"
              display={cents(delta)}
              value={toCents(delta)}
              min={1}
              max={99}
              suffix="¢"
              dirty={delta !== c.deltaThreshold}
              onCommit={(v) => stageIn("deltas", leafId, fromCents(v))}
            />
            in{" "}
            <InlineNumber
              {...common}
              label="Look-back window"
              display={humanDuration(window)}
              value={Math.round(window / 60_000)}
              min={1}
              max={60}
              suffix="min"
              dirty={window !== c.windowMs}
              onCommit={(v) => stageIn("windows", leafId, v * 60_000)}
            />
          </span>
        );
      }
      case "cumulative_notional": {
        const staged = edits.minNotionals?.[leafId] ?? c.minNotional;
        return (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            at least{" "}
            <InlineNumber
              {...common}
              label="Minimum liquidity"
              display={`$${staged.toLocaleString()}`}
              value={Math.round(staged)}
              min={1}
              max={10_000_000}
              suffix="$"
              dirty={staged !== c.minNotional}
              onCommit={(v) => stageIn("minNotionals", leafId, v)}
            />
          </span>
        );
      }
      case "visible_levels": {
        const staged = edits.minLevels?.[leafId] ?? c.minLevels;
        return (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            at least{" "}
            <InlineNumber
              {...common}
              label="Minimum book levels"
              display={`${staged} levels`}
              value={staged}
              min={1}
              max={50}
              suffix="levels"
              dirty={staged !== c.minLevels}
              onCommit={(v) => stageIn("minLevels", leafId, v)}
            />
          </span>
        );
      }
      case "time_window":
        // Exact timestamps are a builder job — the panel stays light.
        return <span className="text-[11px] text-faint">schedule</span>;
    }
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
            <RenameField
              id={row.id}
              name={row.name}
              fallback={def.name || "Untitled strategy"}
              className="text-[15px] font-semibold"
            />
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
          {/* Secondary facts + tags — the compact dashboard card dropped these. */}
          <div className="mt-1.5">
            <MetaRow row={row} />
          </div>
          <TagsRow row={row} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/strategies/${row.id}`}
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
          {/* The one root-level number worth tuning fast; recurrence, expiry and
              caps stay in the builder so the panel doesn't become a form. */}
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted">
            <span>All of the above must hold for</span>
            <InlineNumber
              label="Hold window"
              display={stagedHold === 0 ? "instantly" : humanDuration(stagedHold)}
              value={Math.round(stagedHold / 60_000)}
              min={0}
              max={1440}
              suffix="min"
              dirty={stagedHold !== def.holdsForMs}
              disabled={!editable}
              onCommit={(v) => setEdits((prev) => ({ ...prev, holdsForMs: v * 60_000 }))}
            />
          </div>
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
        freshness={evaluation.data?.markets}
        freshnessReceivedAtMs={evaluation.dataUpdatedAt || undefined}
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
