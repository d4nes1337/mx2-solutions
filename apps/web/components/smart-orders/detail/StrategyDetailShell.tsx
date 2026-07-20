"use client";

/**
 * Strategy detail — the "what is ACTUALLY happening" page. One glance answers:
 * is it live, how far along is the hold window, what do the conditions read
 * right now, what has the engine done (timeline), and which orders came out
 * of it (with fills). Minimum prose; numbers and states do the talking.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  LiveDot,
  Segmented,
  Skeleton,
  cn,
} from "@/components/ui";
import { AreaChart, type ChartPoint } from "@/components/charts/AreaChart";
import { useTokenPricesHistory } from "@/lib/queries";
import { conditionLeavesOf, docFromDefinition, marketLabel } from "@/lib/smart-orders/doc";
import { conditionSummary, formatActual, cents } from "@/lib/smart-orders/summaries";
import { strategySentence, humanDuration } from "@/lib/smart-orders/sentence";
import { userStatus } from "@/lib/smart-orders/status";
import {
  useStrategy,
  useStrategyControl,
  useStrategyDisarm,
  useStrategyEvaluation,
  useStrategyTimeline,
  type StrategyEvaluation,
  type StrategyRow,
  type StrategyTimeline,
} from "@/lib/smart-orders/queries";
import { ActivityTimeline } from "./ActivityTimeline";
import { LinkedOrders } from "./LinkedOrders";
import { QuickEditSheet } from "../QuickEditSheet";

import { useNow } from "@/lib/smart-orders/use-now";
import { ConditionCharts } from "./ConditionCharts";

function DwellProgress({ evaluation, now }: { evaluation: StrategyEvaluation; now: number }) {
  const holding = evaluation.trueSince !== null && evaluation.holdsForMs > 0;
  const cooldownMs = evaluation.cooldownUntil
    ? new Date(evaluation.cooldownUntil).getTime() - now
    : 0;
  if (cooldownMs > 0) {
    return (
      <div className="text-[12px] text-muted">
        Cooldown — next trigger possible in{" "}
        <span className="tabular text-fg">{humanDuration(cooldownMs)}</span>
      </div>
    );
  }
  if (!holding) {
    return (
      <div className="text-[12px] text-muted">
        {evaluation.satisfied
          ? "Conditions just met — hold window starting…"
          : evaluation.staleTokenIds.length > 0
            ? "Waiting for market data…"
            : evaluation.holdsForMs === 0
              ? "Triggers the moment conditions are met"
              : "Waiting for conditions to be met"}
      </div>
    );
  }
  const elapsed = Math.max(0, now - new Date(evaluation.trueSince!).getTime());
  const pct = Math.min(100, (elapsed / evaluation.holdsForMs) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">Conditions holding</span>
        <span className="tabular font-medium text-fg">
          {humanDuration(Math.min(elapsed, evaluation.holdsForMs))} of{" "}
          {humanDuration(evaluation.holdsForMs)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ConditionsPanel({
  row,
  evaluation,
}: {
  row: StrategyRow;
  evaluation?: StrategyEvaluation;
}) {
  const doc = docFromDefinition(row.definitionV2);
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
  if (evaluation?.root) walk(evaluation.root);

  const leaves = conditionLeavesOf(doc.expr);

  return (
    <Card>
      <CardHeader>Conditions</CardHeader>
      <div className="divide-y divide-border">
        {leaves.map(({ id, condition: c }) => {
          const r = results.get(id);
          const { summary, detail } = conditionSummary(doc, c);
          const actual = r ? formatActual(c.kind, r.actual) : null;
          return (
            <div key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-fg">{summary}</div>
                {detail ? <div className="truncate text-[11px] text-faint">{detail}</div> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {actual !== null ? (
                  <span className="tabular text-[12px] text-muted">now {actual}</span>
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
          <div className="px-4 py-3 text-[12px] text-muted">No conditions.</div>
        ) : null}
      </div>
    </Card>
  );
}

export function StrategyDetailShell() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const strategy = useStrategy(id);
  const evaluation = useStrategyEvaluation(id);
  const timeline = useStrategyTimeline(id);
  const control = useStrategyControl();
  const disarm = useStrategyDisarm();
  const now = useNow();
  const [quickEdit, setQuickEdit] = useState(false);

  if (strategy.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (strategy.error || !strategy.data) {
    return (
      <Empty>
        Smart Order not found.{" "}
        <Link href="/smart-orders" className="text-accent underline">
          Back to Smart Orders
        </Link>
      </Empty>
    );
  }

  const row = strategy.data;
  const def = row.definitionV2;
  const doc = docFromDefinition(def);
  const status = userStatus(row.status, {
    actionKind: def.action.kind,
    execution: def.action.kind === "order" ? def.action.execution : undefined,
  });
  const active = status.group === "monitoring";
  const paused = row.status === "PAUSED";
  const isAuto = def.action.kind === "order" && def.action.execution === "auto";

  return (
    <div className="space-y-4">
      <Link
        href="/smart-orders"
        className="inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={13} aria-hidden /> Smart Orders
      </Link>

      {/* ── Status hero ── */}
      <Card>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[17px] font-semibold text-fg">
                  {row.name || def.name || "Smart Order"}
                </h1>
                {status.live ? (
                  <LiveDot
                    label={status.label.toUpperCase()}
                    tone={status.tone === "neg" ? "neg" : status.tone === "warn" ? "warn" : "pos"}
                  />
                ) : (
                  <Badge tone={status.tone}>{status.label}</Badge>
                )}
                {isAuto ? (
                  row.autoDisabled ? (
                    <Badge tone="warn" title="You disarmed automatic order placement">
                      AUTO OFF
                    </Badge>
                  ) : row.autoDegraded ? (
                    <Badge
                      tone="warn"
                      title="This strategy asks for automatic execution, but the server can't deliver it — triggers will wait for your confirmation."
                    >
                      AUTO UNAVAILABLE
                    </Badge>
                  ) : (
                    <Badge tone="brand">AUTO</Badge>
                  )
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{strategySentence(doc)}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {active ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={control.isPending}
                  onClick={() => control.mutate({ id: row.id, action: "pause" })}
                >
                  Pause
                </Button>
              ) : null}
              {paused ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={control.isPending}
                  onClick={() => control.mutate({ id: row.id, action: "resume" })}
                >
                  Resume
                </Button>
              ) : null}
              {isAuto && (active || paused) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disarm.isPending}
                  title={
                    row.autoDisabled
                      ? "Re-enable automatic order placement"
                      : "Keep watching, but stop placing orders automatically"
                  }
                  onClick={() =>
                    disarm.mutate({ id: row.id, action: row.autoDisabled ? "rearm" : "disarm" })
                  }
                >
                  {row.autoDisabled ? "Re-arm auto" : "Disarm auto"}
                </Button>
              ) : null}
              {(active || paused) && row.version === 2 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Edit parameters here — applies as a new version (canvas still available inside)"
                  onClick={() => setQuickEdit(true)}
                >
                  <Pencil size={11} aria-hidden /> Edit
                </Button>
              ) : null}
              {active || paused ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={control.isPending}
                  onClick={() =>
                    control.mutate(
                      { id: row.id, action: "cancel" },
                      { onSuccess: () => router.push("/smart-orders") },
                    )
                  }
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
          {evaluation.data && (active || paused) ? (
            <DwellProgress evaluation={evaluation.data} now={now} />
          ) : null}
          {row.errorMessage ? <p className="text-[12px] text-neg">{row.errorMessage}</p> : null}
        </div>
      </Card>

      {/* ── Body: live state left, activity right ── */}
      <div className={cn("grid gap-4", "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]")}>
        <div className="space-y-4">
          <ConditionsPanel
            row={row}
            {...(evaluation.data ? { evaluation: evaluation.data } : {})}
          />
          <ConditionCharts row={row} timeline={timeline.data} />
          <LinkedOrders orders={timeline.data?.orders ?? []} doc={doc} />
        </div>
        <ActivityTimeline
          timeline={timeline.data}
          loading={timeline.isLoading}
          createdAt={row.createdAt}
        />
      </div>

      {/* Versioned-edit lineage: this row replaced / was replaced by another. */}
      {row.supersedes || row.supersededBy ? (
        <p className="text-[11px] text-faint">
          {row.supersedes ? (
            <>
              Edited version of an earlier strategy —{" "}
              <Link
                href={`/smart-orders/${row.supersedes}`}
                className="text-accent hover:underline"
              >
                view previous version
              </Link>
              . Spend caps carried over.
            </>
          ) : null}
          {row.supersededBy ? (
            <>
              This strategy was replaced by an edit —{" "}
              <Link
                href={`/smart-orders/${row.supersededBy}`}
                className="text-accent hover:underline"
              >
                view current version
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <QuickEditSheet
        row={row}
        open={quickEdit}
        onClose={() => setQuickEdit(false)}
        onApplied={(newId) => router.push(`/smart-orders/${newId}`)}
      />
    </div>
  );
}
