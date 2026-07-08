"use client";

/**
 * One Smart Order on the monitor page: plain-English summary, user-facing
 * status, live "would trigger" state (expanded on demand), quick actions.
 * Works for v1 rules too — they arrive normalized as definitionV2.
 */
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { Badge, Button, LiveDot, cn } from "@/components/ui";
import { docFromDefinition, marketLabel, docMarketRefs } from "@/lib/smart-orders/doc";
import { strategySentence, humanDuration } from "@/lib/smart-orders/sentence";
import { userStatus } from "@/lib/smart-orders/status";
import {
  useStrategyControl,
  useStrategyEvaluation,
  type StrategyRow,
} from "@/lib/smart-orders/queries";

const timeAgo = (iso: string | null): string => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** Estimated exposure: order cost, or the auto limits when armed. */
const exposure = (row: StrategyRow): string | null => {
  const a = row.definitionV2.action;
  if (a.kind !== "order") return null;
  const cost = a.price * a.size;
  if (a.execution === "auto" && row.definitionV2.limits) {
    return `up to $${row.definitionV2.limits.maxTotalNotional.toLocaleString()}`;
  }
  return `≈ $${cost.toFixed(2)}`;
};

function LiveState({ id }: { id: string }) {
  const evaluation = useStrategyEvaluation(id);
  if (evaluation.isLoading) return <p className="text-[12px] text-muted">Checking live state…</p>;
  if (!evaluation.data) return null;
  const e = evaluation.data;
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">Would trigger now?</span>
        <Badge tone={e.satisfied ? "pos" : e.staleTokenIds.length > 0 ? "warn" : "neutral"}>
          {e.satisfied ? "Yes" : e.staleTokenIds.length > 0 ? "Waiting for data" : "Not yet"}
        </Badge>
      </div>
      {e.markets.map((m) => (
        <div key={m.tokenId} className="tabular flex justify-between text-[11px] text-muted">
          <span>{m.tokenId.slice(0, 10)}…</span>
          <span>
            {m.bestAsk !== null ? `ask ${Math.round(m.bestAsk * 100)}¢` : "no data"}
            {m.bestBid !== null ? ` · bid ${Math.round(m.bestBid * 100)}¢` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StrategyCard({ row }: { row: StrategyRow }) {
  const control = useStrategyControl();
  const [expanded, setExpanded] = useState(false);
  const def = row.definitionV2;
  const doc = docFromDefinition(def);
  const status = userStatus(row.status, {
    actionKind: def.action.kind,
    execution: def.action.kind === "order" ? def.action.execution : undefined,
  });
  const active = status.group === "monitoring";
  const markets = docMarketRefs(doc);

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-panel transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-fg">
              {row.name || def.name || "Smart Order"}
            </span>
            {status.live ? (
              <LiveDot
                label={status.label.toUpperCase()}
                tone={status.tone === "neg" ? "neg" : status.tone === "warn" ? "warn" : "pos"}
              />
            ) : (
              <Badge tone={status.tone}>{status.label}</Badge>
            )}
            {def.action.kind === "order" && def.action.execution === "auto" ? (
              <Badge tone="brand">AUTO</Badge>
            ) : null}
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{strategySentence(doc)}</p>
          <div className="tabular mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            {markets.slice(0, 2).map((m) => (
              <span key={m.tokenId} className="truncate">
                {marketLabel(doc, m)}
              </span>
            ))}
            <span>last check {timeAgo(row.lastEvaluatedAt)}</span>
            {row.triggerCount > 0 ? <span>triggered {row.triggerCount}×</span> : null}
            {exposure(row) ? <span>exposure {exposure(row)}</span> : null}
            {def.recurrence.kind === "repeat" ? (
              <span>
                repeats {row.triggerCount}/{def.recurrence.maxRepeats} ·{" "}
                {humanDuration(def.recurrence.cooldownMs)} cooldown
              </span>
            ) : null}
          </div>
          {row.errorMessage ? (
            <p className="mt-1.5 text-[12px] text-neg">{row.errorMessage}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
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
          {(active || row.status === "PAUSED") && row.version === 2 ? (
            <Link
              href={`/smart-orders/${row.id}/edit`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-border-strong"
            >
              <Pencil size={11} aria-hidden /> Edit
            </Link>
          ) : null}
          {active || row.status === "PAUSED" ? (
            <Button
              variant="danger"
              size="sm"
              disabled={control.isPending}
              onClick={() => control.mutate({ id: row.id, action: "cancel" })}
            >
              Cancel
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="rounded-md p-1 text-muted transition-colors hover:text-fg"
            aria-label={expanded ? "Collapse" : "Expand live state"}
          >
            <ChevronDown
              size={15}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3">
          <LiveState id={row.id} />
        </div>
      ) : null}
    </div>
  );
}
