"use client";

/**
 * Presentational node bodies for the builder canvas. Deliberately free of any
 * React Flow state logic beyond Handles, so they stay testable and the canvas
 * library remains swappable (ADR-0010).
 */
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { AlertCircle, Bell, CircleDollarSign, GitBranch, OctagonX, TrendingUp } from "lucide-react";
import { cn } from "@/components/ui";

export interface MarketNodeData extends Record<string, unknown> {
  title: string;
  outcome: string;
  bestAsk: number | null;
  bestBid: number | null;
  stale: boolean;
  bound: boolean;
}

export interface ConditionNodeData extends Record<string, unknown> {
  summary: string;
  detail: string | null;
  state: "pass" | "fail" | "stale" | "unknown";
  actual: string | null;
  negated: boolean;
  issue: string | null;
}

export interface LogicNodeData extends Record<string, unknown> {
  op: "and" | "or" | "not";
  satisfied: boolean | null;
  isRoot: boolean;
}

export interface ActionNodeData extends Record<string, unknown> {
  kind: "alert" | "order" | "stop_strategy";
  summary: string;
  execution: "prepare" | "auto" | null;
  issue: string | null;
}

const shell = (selected: boolean | undefined, issue?: boolean) =>
  cn(
    "w-[260px] rounded-xl border bg-surface px-3.5 py-3 shadow-panel transition-all",
    selected ? "border-brand shadow-elev" : issue ? "border-neg/60" : "border-border",
  );

const statePill = (state: ConditionNodeData["state"], actual: string | null) => {
  const styles: Record<string, string> = {
    pass: "bg-pos/10 text-pos border-pos/30",
    fail: "bg-surface-2 text-muted border-border",
    stale: "bg-warn/10 text-warn border-warn/30",
    unknown: "bg-surface-2 text-faint border-border",
  };
  const labels: Record<string, string> = {
    pass: "holds",
    fail: "not yet",
    stale: "no fresh data",
    unknown: "—",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        styles[state],
      )}
    >
      {state === "pass" ? "✓" : state === "stale" ? "⏳" : "○"} {labels[state]}
      {actual ? <span className="tabular text-[10px] opacity-80">· {actual}</span> : null}
    </span>
  );
};

export function MarketNode({ data, selected }: NodeProps<Node<MarketNodeData>>) {
  return (
    <div className={shell(selected, !data.bound)}>
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-soft text-accent">
          <TrendingUp size={14} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Market</div>
          <div className="truncate text-[13px] font-medium text-fg">{data.title}</div>
        </div>
      </div>
      <div className="tabular mt-2 flex items-center gap-2 text-[11px] text-muted">
        {data.bestAsk !== null ? <span>ask {Math.round(data.bestAsk * 100)}¢</span> : null}
        {data.bestBid !== null ? <span>bid {Math.round(data.bestBid * 100)}¢</span> : null}
        {data.stale ? <span className="text-warn">waiting for data…</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
}

export function ConditionNode({ data, selected }: NodeProps<Node<ConditionNodeData>>) {
  return (
    <div className={shell(selected, Boolean(data.issue))}>
      <Handle type="target" position={Position.Left} className="!bg-border-strong" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            {data.negated ? "Condition · NOT" : "Condition"}
          </div>
          <div className="text-[13px] font-medium leading-snug text-fg">{data.summary}</div>
          {data.detail ? <div className="mt-0.5 text-[11px] text-muted">{data.detail}</div> : null}
        </div>
      </div>
      <div className="mt-2">{statePill(data.state, data.actual)}</div>
      {data.issue ? (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-neg">
          <AlertCircle size={11} aria-hidden /> {data.issue}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
}

export function LogicNode({ data, selected }: NodeProps<Node<LogicNodeData>>) {
  const label = data.op === "and" ? "ALL OF" : data.op === "or" ? "ANY OF" : "NOT";
  return (
    <div
      className={cn(
        "rounded-full border bg-surface px-4 py-2 shadow-panel transition-all",
        selected ? "border-brand shadow-elev" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-border-strong" />
      <div className="flex items-center gap-1.5">
        <GitBranch size={13} className="text-accent" aria-hidden />
        <span className="text-[12px] font-semibold tracking-wide text-fg">{label}</span>
        {data.satisfied !== null ? (
          <span
            className={cn(
              "ml-1 h-1.5 w-1.5 rounded-full",
              data.satisfied ? "bg-pos" : "bg-border-strong",
            )}
          />
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
}

export function ActionNode({ data, selected }: NodeProps<Node<ActionNodeData>>) {
  const icon =
    data.kind === "alert" ? (
      <Bell size={14} aria-hidden />
    ) : data.kind === "stop_strategy" ? (
      <OctagonX size={14} aria-hidden />
    ) : (
      <CircleDollarSign size={14} aria-hidden />
    );
  return (
    <div className={shell(selected, Boolean(data.issue))}>
      <Handle type="target" position={Position.Left} className="!bg-border-strong" />
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-pos/10 text-pos">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
            Action
            {data.execution === "auto" ? (
              <span className="rounded-full border border-brand/40 bg-brand-soft px-1.5 text-[9px] font-bold text-accent">
                AUTO
              </span>
            ) : null}
          </div>
          <div className="text-[13px] font-medium leading-snug text-fg">{data.summary}</div>
        </div>
      </div>
      {data.issue ? (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-neg">
          <AlertCircle size={11} aria-hidden /> {data.issue}
        </div>
      ) : null}
    </div>
  );
}

export const NODE_TYPES = {
  market: MarketNode,
  condition: ConditionNode,
  logic: LogicNode,
  action: ActionNode,
} as const;
