"use client";

/**
 * Strategy ACTIVITY — the record of what this strategy has actually done:
 * status, hold-window progress, the engine timeline, the orders it produced
 * (with fills) and the version lineage. Deep-linkable and shareable.
 *
 * It deliberately does NOT render the condition grid: the grid is an EDITING
 * surface and lives in exactly two places — the dashboard side panel (fast
 * number tuning) and the builder page (structural changes). Showing a
 * read-only third copy here is what made the flow feel duplicated.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, SlidersHorizontal } from "lucide-react";
import { Badge, Button, Card, Empty, LiveDot, Skeleton, cn } from "@/components/ui";
import { docFromDefinition } from "@/lib/strategies/doc";
import { strategySentence, humanDuration } from "@/lib/strategies/sentence";
import { userStatus } from "@/lib/strategies/status";
import {
  useStrategy,
  useStrategyControl,
  useStrategyDisarm,
  useStrategyEvaluation,
  useStrategyTimeline,
  type StrategyEvaluation,
  type StrategyRow,
  type StrategyTimeline,
} from "@/lib/strategies/queries";
import { RenameField } from "../RenameField";
import { ActivityTimeline } from "./ActivityTimeline";
import { LinkedOrders } from "./LinkedOrders";

import { useNow } from "@/lib/strategies/use-now";

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
        Strategy not found.{" "}
        <Link href="/strategies" className="text-accent underline">
          Back to strategies
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/strategies"
          className="inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft size={13} aria-hidden /> Strategies
        </Link>
        {/* Names the page so it reads as the record, not another editor. */}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
          Activity
        </span>
      </div>

      {/* ── Status hero ── */}
      <Card>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 text-[17px] font-semibold text-fg">
                  <RenameField
                    id={row.id}
                    name={row.name}
                    fallback={def.name || "Untitled strategy"}
                    className="text-[17px] font-semibold"
                  />
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
                <>
                  <Link href={`/strategies?focus=${encodeURIComponent(row.id)}`}>
                    <Button variant="ghost" size="sm" title="Tune the numbers in the side panel">
                      <SlidersHorizontal size={11} aria-hidden /> Tune
                    </Button>
                  </Link>
                  <Link href={`/strategies/${row.id}/edit`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Open the builder (add markets, rewire logic)"
                    >
                      <Pencil size={11} aria-hidden /> Edit in builder
                    </Button>
                  </Link>
                </>
              ) : null}
              {active || paused ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={control.isPending}
                  onClick={() =>
                    control.mutate(
                      { id: row.id, action: "cancel" },
                      { onSuccess: () => router.push("/strategies") },
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

      {/* ── Body: what it DID (the grid lives in the panel + builder) ── */}
      <div className={cn("grid gap-4", "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]")}>
        <LinkedOrders orders={timeline.data?.orders ?? []} doc={doc} />
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
              <Link href={`/strategies/${row.supersedes}`} className="text-accent hover:underline">
                view previous version
              </Link>
              . Spend caps carried over.
            </>
          ) : null}
          {row.supersededBy ? (
            <>
              This strategy was replaced by an edit —{" "}
              <Link
                href={`/strategies/${row.supersededBy}`}
                className="text-accent hover:underline"
              >
                view current version
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
