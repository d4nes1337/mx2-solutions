"use client";

import { useEffect, useState } from "react";
import { useRuleControl, useRuleEvaluateNow, useRules } from "@/lib/queries";
import { fmtDuration, ruleStatusMeta } from "@/lib/rules";
import type { RulePredicateInput, RuleRow } from "@/lib/types";
import { Badge, Button, Empty, Spinner, cn } from "./ui";

const summarize = (p: RulePredicateInput): string => {
  if (p.kind === "price")
    return `best ${p.source} ${p.comparator === "lte" ? "≤" : "≥"} ${p.threshold}`;
  if (p.kind === "cumulative_notional") return `Σ notional ≥ $${p.minNotional}`;
  return `≥ ${p.minLevels} levels`;
};

const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
};

function RuleCard({ rule }: { rule: RuleRow }) {
  const control = useRuleControl();
  const meta = ruleStatusMeta(rule.status);
  const isActive = rule.status === "ACTIVE_WAITING" || rule.status === "ACTIVE_ACCUMULATING";
  const evalNow = useRuleEvaluateNow(rule.id, isActive);
  const now = useNow(rule.status === "ACTIVE_ACCUMULATING");

  const windowMs = rule.definition.continuousWindowMs;
  const elapsed =
    rule.status === "ACTIVE_ACCUMULATING" && rule.trueSince
      ? now - new Date(rule.trueSince).getTime()
      : 0;
  const pct = Math.min(100, windowMs > 0 ? (elapsed / windowMs) * 100 : 0);

  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={meta.tone} dot={meta.live}>
              {meta.label}
            </Badge>
            <span className="text-xs text-muted">{rule.side}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {rule.definition.predicates.map(summarize).join(" · ")}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            continuous {fmtDuration(windowMs)} · prepares {rule.definition.action.size} @{" "}
            {rule.definition.action.price}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {rule.status === "PAUSED" ? (
            <Button
              variant="ghost"
              onClick={() => control.mutate({ id: rule.id, action: "resume" })}
              disabled={control.isPending}
            >
              Resume
            </Button>
          ) : isActive ? (
            <Button
              variant="ghost"
              onClick={() => control.mutate({ id: rule.id, action: "pause" })}
              disabled={control.isPending}
            >
              Pause
            </Button>
          ) : null}
          {rule.status !== "CANCELLED" &&
          rule.status !== "EXECUTED_MANUALLY" &&
          rule.status !== "EXPIRED" ? (
            <Button
              variant="danger"
              onClick={() => control.mutate({ id: rule.id, action: "cancel" })}
              disabled={control.isPending}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {/* Accumulation progress */}
      {rule.status === "ACTIVE_ACCUMULATING" ? (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted">
            true for {fmtDuration(elapsed)} / {fmtDuration(windowMs)}
          </div>
        </div>
      ) : null}

      {/* Live evaluate-now snapshot */}
      {isActive && evalNow.data ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {evalNow.data.isStale ? (
            <span className="text-warn">data stale — window held back</span>
          ) : (
            (evalNow.data.predicates ?? []).map((p, i) => (
              <span key={i} className={cn(p.satisfied ? "text-pos" : "text-muted")}>
                {p.satisfied ? "✓" : "○"} {p.kind.replace(/_/g, " ")}
                {p.actual !== null ? ` (${p.actual})` : ""}
              </span>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RuleList({ conditionId }: { conditionId?: string }) {
  const rules = useRules();

  if (rules.isLoading) return <Spinner label="Loading rules…" />;
  const all = rules.data?.rules ?? [];
  const list = (conditionId ? all.filter((r) => r.conditionId === conditionId) : all)
    .slice()
    .sort((a, b) => ruleStatusMeta(a.status).order - ruleStatusMeta(b.status).order);

  if (list.length === 0) {
    return <Empty>No conditional rules yet. Create one from a market.</Empty>;
  }

  return (
    <div className="space-y-2">
      {list.map((rule) => (
        <RuleCard key={rule.id} rule={rule} />
      ))}
    </div>
  );
}
