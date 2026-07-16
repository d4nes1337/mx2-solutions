"use client";

/**
 * Node bodies for the builder canvas — the multitool surface. Tapping a block
 * selects it and opens its editor in the panel's Block tab (it does NOT grow);
 * the ⌄ button at a block's bottom expands it in place to an editor-fit size,
 * and manually resizing a block past the disclosure threshold reveals the same
 * editor progressively (hybrid editing, owner decision D-025). Bodies stay
 * free of React Flow state logic beyond Handles/NodeResizer, so the canvas
 * library remains swappable (ADR-0010).
 */
import { memo } from "react";
import { Handle, NodeResizer, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  AlertCircle,
  Bell,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  GitBranch,
  OctagonX,
  Repeat2,
  TrendingUp,
  X,
} from "lucide-react";
import { cn } from "@/components/ui";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { ConditionEditor } from "./editors/ConditionEditor";
import { ActionEditor, GroupEditor, RootLogicEditor } from "./editors/ActionEditor";

export interface MarketNodeData extends Record<string, unknown> {
  title: string;
  outcome: string;
  bestAsk: number | null;
  bestBid: number | null;
  stale: boolean;
  bound: boolean;
  tokenId: string;
  /** Watched-but-unreferenced markets can be removed from the canvas. */
  deletable: boolean;
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
  kind: "alert" | "order" | "stop_strategy" | "quote_loop";
  summary: string;
  execution: "prepare" | "auto" | null;
  issue: string | null;
}

// ── Sizing / disclosure ──────────────────────────────────────────────────────

/** Height at/above which a block reveals its editor (scrolling if needed). */
export const DISCLOSE_EDITOR_H = 220;
/** One-click expand targets — tall enough that nothing needs scrolling. */
export const FIT_SIZE = {
  condition: { w: 340, h: 500 },
  action: { w: 360, h: 560 },
  logic: { w: 300, h: 240 },
} as const;
/** Is the node's explicit height in editor-disclosure territory? */
const disclosed = (height: number | undefined): boolean =>
  height !== undefined && height >= DISCLOSE_EDITOR_H;

// Transition only paint-cheap properties — `transition-all` made the browser
// interpolate the large-blur shadow every frame while a node was dragged.
// Tap/selection never changes a block's size (the old 2× growth): selected is
// a border highlight; size comes only from resize or the expand toggle.
const shell = (selected: boolean | undefined, sized: boolean, issue?: boolean) =>
  cn(
    "rounded-xl border bg-surface px-3.5 py-3 shadow-panel transition-[border-color,background-color,box-shadow]",
    sized ? "flex h-full w-full flex-col" : "w-[260px]",
    selected ? "border-brand shadow-elev" : issue ? "border-neg/60" : "border-border",
  );

const RESIZER_PROPS = {
  minWidth: 220,
  minHeight: 88,
  maxWidth: 560,
  maxHeight: 720,
  lineClassName: "!border-brand/40",
  handleClassName: "!h-2.5 !w-2.5 !rounded-sm !border-brand !bg-surface",
} as const;

/** Small in-card remove control (top-right). */
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className="nodrag -mr-1 -mt-1 shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-neg/10 hover:text-neg"
    >
      <X size={12} aria-hidden />
    </button>
  );
}

/**
 * The expand/collapse chevron at a block's bottom: one click resizes the node
 * to its editor-fit size (or back to compact). The same editor also appears
 * by dragging the resize handles past the disclosure threshold.
 */
function ExpandToggle({
  id,
  x,
  y,
  fit,
  expanded,
}: {
  id: string;
  x: number;
  y: number;
  fit: { w: number; h: number };
  expanded: boolean;
}) {
  const setPosition = useBuilderStore((s) => s.setPosition);
  return (
    <button
      type="button"
      aria-label={expanded ? "Collapse block" : "Edit in place"}
      title={expanded ? "Collapse" : "Edit in place"}
      onClick={(e) => {
        e.stopPropagation();
        setPosition(id, expanded ? { x, y } : { x, y, w: fit.w, h: fit.h });
      }}
      className="nodrag mx-auto mt-1.5 flex w-full items-center justify-center rounded-md py-0.5 text-faint transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
    </button>
  );
}

/** Scrollable editor region inside an expanded node. */
function InlineEditor({ children }: { children: React.ReactNode }) {
  return (
    <div className="nowheel mt-2.5 min-h-0 flex-1 overflow-y-auto border-t border-border pt-2.5">
      {children}
    </div>
  );
}

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

export const MarketNode = memo(function MarketNode({
  data,
  width,
  height,
  selected,
}: NodeProps<Node<MarketNodeData>>) {
  const sized = width !== undefined || height !== undefined;
  return (
    <div className={shell(selected, sized, !data.bound)}>
      <NodeResizer isVisible={selected ?? false} {...RESIZER_PROPS} maxHeight={240} />
      <div className="flex items-start gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-soft text-accent">
          <TrendingUp size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Market</div>
          <div className={cn("text-[13px] font-medium text-fg", sized ? "" : "truncate")}>
            {data.title}
          </div>
        </div>
        {data.deletable ? (
          <DeleteButton
            label={`Remove market ${data.title}`}
            onDelete={() => useBuilderStore.getState().removeWatchedMarket(data.tokenId)}
          />
        ) : null}
      </div>
      <div className="tabular mt-2 flex items-center gap-2 text-[11px] text-muted">
        {data.bestAsk !== null ? <span>ask {Math.round(data.bestAsk * 100)}¢</span> : null}
        {data.bestBid !== null ? <span>bid {Math.round(data.bestBid * 100)}¢</span> : null}
        {data.stale ? <span className="text-warn">waiting for data…</span> : null}
      </div>
      {selected ? (
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-snug text-muted">
          Chart and order book are in the panel&apos;s{" "}
          <span className="font-semibold text-fg">Market</span> tab.
          {data.deletable ? "" : " Referenced by a block — unbind it before removing."}
        </p>
      ) : null}
      <Handle id="m-out" type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
});

export const ConditionNode = memo(function ConditionNode({
  id,
  data,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
  selected,
}: NodeProps<Node<ConditionNodeData>>) {
  const sized = width !== undefined || height !== undefined;
  const showEditor = disclosed(height);
  return (
    <div className={shell(selected, sized, Boolean(data.issue))}>
      <NodeResizer isVisible={selected ?? false} {...RESIZER_PROPS} />
      <Handle id="m-in" type="target" position={Position.Left} className="!bg-border-strong" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            {data.negated ? "Condition · NOT" : "Condition"}
          </div>
          <div className="text-[13px] font-medium leading-snug text-fg">{data.summary}</div>
          {data.detail ? <div className="mt-0.5 text-[11px] text-muted">{data.detail}</div> : null}
        </div>
        <DeleteButton
          label="Remove condition"
          onDelete={() => useBuilderStore.getState().removeNode(id)}
        />
      </div>
      <div className="mt-2">{statePill(data.state, data.actual)}</div>
      {data.issue ? (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-neg">
          <AlertCircle size={11} aria-hidden /> {data.issue}
        </div>
      ) : null}
      {showEditor ? (
        <InlineEditor>
          <ConditionEditor id={id} />
        </InlineEditor>
      ) : null}
      <ExpandToggle
        id={id}
        x={positionAbsoluteX}
        y={positionAbsoluteY}
        fit={FIT_SIZE.condition}
        expanded={showEditor}
      />
      <Handle id="t-out" type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
});

export const LogicNode = memo(function LogicNode({
  id,
  data,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
  selected,
}: NodeProps<Node<LogicNodeData>>) {
  const label = data.op === "and" ? "ALL OF" : data.op === "or" ? "ANY OF" : "NOT";
  const sized = width !== undefined || height !== undefined;
  const showEditor = disclosed(height);
  return (
    <div
      className={cn(
        "border bg-surface shadow-panel transition-[border-color,background-color,box-shadow]",
        sized ? "flex h-full w-full flex-col rounded-2xl px-4 py-2.5" : "rounded-full px-4 py-2",
        selected ? "border-brand shadow-elev" : "border-border",
      )}
    >
      <NodeResizer isVisible={selected ?? false} {...RESIZER_PROPS} maxHeight={320} />
      <Handle id="t-in" type="target" position={Position.Left} className="!bg-border-strong" />
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
        {selected && !data.isRoot ? (
          <DeleteButton
            label="Remove group"
            onDelete={() => useBuilderStore.getState().removeNode(id)}
          />
        ) : null}
      </div>
      {showEditor ? (
        <InlineEditor>
          {data.isRoot ? <RootLogicEditor /> : <GroupEditor id={id} op={data.op} />}
        </InlineEditor>
      ) : null}
      {selected ? (
        <ExpandToggle
          id={id}
          x={positionAbsoluteX}
          y={positionAbsoluteY}
          fit={FIT_SIZE.logic}
          expanded={showEditor}
        />
      ) : null}
      <Handle id="t-out" type="source" position={Position.Right} className="!bg-border-strong" />
    </div>
  );
});

export const ActionNode = memo(function ActionNode({
  id,
  data,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
  selected,
}: NodeProps<Node<ActionNodeData>>) {
  const sized = width !== undefined || height !== undefined;
  const showEditor = disclosed(height);
  const icon =
    data.kind === "alert" ? (
      <Bell size={14} aria-hidden />
    ) : data.kind === "stop_strategy" ? (
      <OctagonX size={14} aria-hidden />
    ) : data.kind === "quote_loop" ? (
      <Repeat2 size={14} aria-hidden />
    ) : (
      <CircleDollarSign size={14} aria-hidden />
    );
  return (
    <div className={shell(selected, sized, Boolean(data.issue))}>
      <NodeResizer isVisible={selected ?? false} {...RESIZER_PROPS} />
      <Handle
        id="t-in"
        type="target"
        position={Position.Left}
        className="!bg-border-strong"
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      {data.kind === "order" ? (
        // Market-binding port: drag a market's right handle here to set the
        // market this order trades (only order actions trade a market).
        <Handle
          id="m-in"
          type="target"
          position={Position.Left}
          style={{ top: "70%" }}
          className="!bg-border-strong"
          isConnectableStart={false}
        />
      ) : null}
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
            {data.kind === "quote_loop" ? (
              <span className="rounded-full border border-brand/40 bg-brand-soft px-1.5 text-[9px] font-bold text-accent">
                FARM
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
      {showEditor ? (
        <InlineEditor>
          <ActionEditor />
        </InlineEditor>
      ) : null}
      <ExpandToggle
        id={id}
        x={positionAbsoluteX}
        y={positionAbsoluteY}
        fit={FIT_SIZE.action}
        expanded={showEditor}
      />
    </div>
  );
});

export const NODE_TYPES = {
  market: MarketNode,
  condition: ConditionNode,
  logic: LogicNode,
  action: ActionNode,
} as const;
