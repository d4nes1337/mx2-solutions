"use client";

/**
 * The node canvas: projects the StrategyDoc (plus live evaluation results)
 * into React Flow nodes/edges. Structure is derived — edges always mirror the
 * expression tree — while positions and selection flow back into the store.
 *
 * Rendering strategy (drag smoothness): node positions live in local React
 * state that React Flow mutates directly while dragging; the doc is
 * authoritative only at hydration and on drop. Doc changes and 3s evaluation
 * polls are RECONCILED into the existing arrays, preserving object identity
 * for unchanged nodes so memoized node bodies skip re-rendering and a poll
 * landing mid-drag can never snap or rebuild the graph.
 *
 * Loaded via next/dynamic so React Flow never enters other routes' bundles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ConditionV2, ExprNode, ExprResultNode } from "@mx2/rules";
import {
  conditionLeavesOf,
  docMarketRefs,
  isBound,
  isTokenReferenced,
  marketLabel,
  type StrategyDoc,
} from "@/lib/smart-orders/doc";
import { useBuilderStore } from "@/lib/smart-orders/store";
import type { BuilderIssue } from "@/lib/smart-orders/compile";
import type { DraftEvaluation } from "@/lib/smart-orders/queries";
import { NODE_TYPES, type ConditionNodeData } from "./nodes";

const cents = (p: number) => `${Math.round(p * 100)}¢`;
const usd = (n: number) => `$${n.toLocaleString()}`;

const conditionSummary = (
  doc: StrategyDoc,
  c: ConditionV2,
): { summary: string; detail: string | null } => {
  switch (c.kind) {
    case "price":
      return {
        summary: `${c.market.outcome} price ${c.comparator === "lte" ? "below" : "above"} ${cents(c.threshold)}`,
        detail: marketLabel(doc, c.market),
      };
    case "spread":
      return {
        summary: `Spread ${c.comparator === "lte" ? "under" : "over"} ${cents(c.threshold)}`,
        detail: marketLabel(doc, c.market),
      };
    case "cumulative_notional":
      return {
        summary: `Liquidity ≥ ${usd(c.minNotional)} up to ${cents(c.priceBound)}`,
        detail: marketLabel(doc, c.market),
      };
    case "visible_levels":
      return {
        summary: `≥ ${c.minLevels} book levels up to ${cents(c.priceBound)}`,
        detail: marketLabel(doc, c.market),
      };
    case "time_window":
      return { summary: "Within a time window", detail: null };
    case "price_move":
      return {
        summary: `${c.market.outcome} ${c.direction === "drop" ? "drops" : c.direction === "rise" ? "rises" : "moves"} ${cents(c.deltaThreshold)}+ in ${Math.round(c.windowMs / 60_000)}m`,
        detail: marketLabel(doc, c.market),
      };
    case "trailing":
      return {
        summary:
          c.mode === "stop"
            ? `${c.market.outcome} falls ${cents(c.offset)} from its peak`
            : `${c.market.outcome} rebounds ${cents(c.offset)} off its low`,
        detail: marketLabel(doc, c.market),
      };
  }
};

/** Flatten the evaluation result tree into per-node lookups. */
const indexResults = (
  node: ExprResultNode | undefined,
  into: Map<string, ExprResultNode>,
): void => {
  if (!node) return;
  into.set(node.id, node);
  if (node.type === "group") for (const child of node.children) indexResults(child, into);
};

const formatActual = (kind: ConditionV2["kind"], actual: number | null): string | null => {
  if (actual === null) return null;
  switch (kind) {
    case "price":
    case "spread":
    case "price_move":
    case "trailing":
      return cents(actual);
    case "cumulative_notional":
      return usd(Math.round(actual));
    case "visible_levels":
      return String(actual);
    case "time_window":
      return null;
  }
};

/** Pure projection: StrategyDoc (+ live evaluation, validation issues) → graph. */
function buildGraph(
  doc: StrategyDoc,
  evaluation: DraftEvaluation | undefined,
  issues: BuilderIssue[],
): { nodes: Node[]; edges: Edge[] } {
  const results = new Map<string, ExprResultNode>();
  indexResults(evaluation?.root, results);
  const freshness = new Map(evaluation?.markets.map((m) => [m.tokenId, m]) ?? []);
  const issueFor = (nodeId: string) => issues.find((i) => i.nodeId === nodeId)?.message ?? null;

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const pos = (id: string, fx: number, fy: number) => doc.positions[id] ?? { x: fx, y: fy };

  // Market nodes (referenced by blocks + canvas-watched extras).
  docMarketRefs(doc).forEach((ref, i) => {
    const f = freshness.get(ref.tokenId);
    nodes.push({
      id: `market:${ref.tokenId}`,
      type: "market",
      position: pos(`market:${ref.tokenId}`, 0, 40 + i * 130),
      data: {
        title: marketLabel(doc, ref),
        outcome: ref.outcome,
        bestAsk: f?.bestAsk ?? null,
        bestBid: f?.bestBid ?? null,
        stale: f ? !f.hasData : true,
        bound: true,
        tokenId: ref.tokenId,
        deletable: !isTokenReferenced(doc, ref.tokenId),
      },
      selected: doc.selectedNodeId === `market:${ref.tokenId}`,
    });
  });

  // Condition + logic nodes from the expression tree.
  let condRow = 0;
  let groupRow = 0;
  const walk = (node: ExprNode, parentId: string, negated: boolean): void => {
    if (node.type === "condition") {
      const c = node.condition;
      const r = results.get(node.id);
      const cr = r?.type === "condition" ? r.result : null;
      const { summary, detail } = conditionSummary(doc, c);
      const state: ConditionNodeData["state"] = !evaluation
        ? "unknown"
        : cr?.stale
          ? "stale"
          : cr?.satisfied
            ? "pass"
            : "fail";
      nodes.push({
        id: node.id,
        type: "condition",
        position: pos(node.id, 300, 40 + condRow * 130),
        data: {
          summary,
          detail,
          state,
          actual: cr ? formatActual(c.kind, cr.actual) : null,
          negated,
          issue: issueFor(node.id),
        },
        selected: doc.selectedNodeId === node.id,
      });
      condRow++;
      if (c.kind !== "time_window" && isBound(c.market)) {
        edges.push({
          id: `m-${node.id}`,
          source: `market:${c.market.tokenId}`,
          target: node.id,
          style: { strokeDasharray: "4 3" },
        });
      }
      edges.push({
        id: `e-${node.id}`,
        source: node.id,
        target: parentId,
        animated: state === "pass",
      });
      return;
    }
    // group
    if (node.id !== "root") {
      const r = results.get(node.id);
      nodes.push({
        id: node.id,
        type: "logic",
        position: pos(node.id, 620, 80 + groupRow * 110),
        data: { op: node.op, satisfied: r ? r.satisfied : null, isRoot: false },
        selected: doc.selectedNodeId === node.id,
      });
      groupRow++;
      edges.push({ id: `e-${node.id}`, source: node.id, target: parentId });
    }
    const childParent = node.id === "root" ? "root" : node.id;
    for (const child of node.children) walk(child, childParent, negated !== (node.op === "not"));
  };

  // Root logic node + action node.
  const rootResult = results.get("root");
  const rows = Math.max(1, conditionLeavesOf(doc.expr).length);
  const midY = 40 + ((rows - 1) * 130) / 2;
  nodes.push({
    id: "root",
    type: "logic",
    position: pos("root", 640, midY + 14),
    data: {
      op: doc.expr.op,
      satisfied: evaluation ? (rootResult?.satisfied ?? null) : null,
      isRoot: true,
    },
    selected: doc.selectedNodeId === "root",
  });
  for (const child of doc.expr.children) walk(child, "root", false);

  const actionSummary =
    doc.action.kind === "alert"
      ? "Alert me"
      : doc.action.kind === "stop_strategy"
        ? "Stop another Smart Order"
        : doc.action.kind === "quote_loop"
          ? `Quote ${doc.action.sizeShares} both sides at mid ±${doc.action.targetSpreadCents}¢`
          : `${doc.action.side === "BUY" ? "Buy" : "Sell"} ${doc.action.size} ${doc.action.market.outcome} at ${cents(doc.action.price)}`;
  nodes.push({
    id: "action",
    type: "action",
    position: pos("action", 900, midY),
    data: {
      kind: doc.action.kind,
      summary: actionSummary,
      execution: doc.action.kind === "order" ? doc.action.execution : null,
      issue: issueFor("action"),
    },
    selected: doc.selectedNodeId === "action",
  });
  edges.push({
    id: "e-root-action",
    source: "root",
    target: "action",
    animated: Boolean(evaluation?.satisfied),
    style: { strokeWidth: 2 },
  });

  // Manual sizes (resize handles / expand toggle) ride along with positions.
  for (const n of nodes) {
    const p = doc.positions[n.id];
    if (p?.w !== undefined) n.width = p.w;
    if (p?.h !== undefined) n.height = p.h;
  }

  return { nodes, edges };
}

const shallowEqualData = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (!Object.is(a[k], b[k])) return false;
  return true;
};

/**
 * Merge a freshly-built graph into the live arrays. Nodes whose payload is
 * unchanged keep their previous object identity (so memoized bodies bail);
 * positions AND sizes come from the live array when `preferLivePositions`
 * (evaluation ticks) or for the node currently being dragged/resized.
 */
function reconcileNodes(
  prev: Node[],
  fresh: Node[],
  opts: { preferLivePositions: boolean; draggingId: string | null },
): Node[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return fresh.map((fn) => {
    const pn = prevById.get(fn.id);
    if (!pn) return fn;
    const keepLive = opts.preferLivePositions || fn.id === opts.draggingId;
    const position = keepLive ? pn.position : fn.position;
    const width = keepLive ? pn.width : fn.width;
    const height = keepLive ? pn.height : fn.height;
    if (
      pn.type === fn.type &&
      pn.selected === fn.selected &&
      pn.position.x === position.x &&
      pn.position.y === position.y &&
      pn.width === width &&
      pn.height === height &&
      pn.className === fn.className &&
      shallowEqualData(pn.data, fn.data)
    ) {
      return pn;
    }
    return { ...fn, position, width, height };
  });
}

function reconcileEdges(prev: Edge[], fresh: Edge[]): Edge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return fresh.map((fe) => {
    const pe = prevById.get(fe.id);
    if (!pe) return fe;
    if (pe.source === fe.source && pe.target === fe.target && pe.animated === fe.animated) {
      return pe;
    }
    return fe;
  });
}

export default function BuilderCanvas({
  evaluation,
  issues,
}: {
  evaluation: DraftEvaluation | undefined;
  issues: BuilderIssue[];
}) {
  const doc = useBuilderStore((s) => s.doc);
  const select = useBuilderStore((s) => s.select);
  const setPosition = useBuilderStore((s) => s.setPosition);
  const revealTick = useBuilderStore((s) => s.revealTick);

  // Latest props/doc for effects that must not re-fire on their changes.
  const evalRef = useRef(evaluation);
  evalRef.current = evaluation;
  const docRef = useRef(doc);
  docRef.current = doc;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  const draggingId = useRef<string | null>(null);
  /** Last dimensions seen during an active NodeResizer gesture. */
  const resizeLast = useRef<{ id: string; width: number; height: number } | null>(null);

  // Staged reveal: for ~2.5s after the AI replaces the doc, nodes mount with a
  // cascading entrance (CSS animation, reduced-motion-gated in globals.css).
  const revealRef = useRef({ tick: 0, at: 0 });
  if (revealTick !== revealRef.current.tick) {
    revealRef.current = { tick: revealTick, at: Date.now() };
  }

  const initialGraph = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  if (initialGraph.current === null) initialGraph.current = buildGraph(doc, evaluation, issues);
  const [nodes, setNodes] = useState<Node[]>(initialGraph.current.nodes);
  const [edges, setEdges] = useState<Edge[]>(initialGraph.current.edges);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Doc/validation authority: rebuild + reconcile on structural change, drop,
  // selection, or staged reveal. Never moves the node under the pointer.
  useEffect(() => {
    const fresh = buildGraph(doc, evalRef.current, issues);
    if (revealTick > 0 && Date.now() - revealRef.current.at < 2_500) {
      fresh.nodes.forEach((n, i) => {
        n.className = "node-reveal";
        n.style = { ...n.style, animationDelay: `${i * 70}ms` };
      });
    }
    setNodes((prev) =>
      reconcileNodes(prev, fresh.nodes, {
        preferLivePositions: false,
        draggingId: draggingId.current,
      }),
    );
    setEdges((prev) => reconcileEdges(prev, fresh.edges));
  }, [doc, issues, revealTick]);

  // Live evaluation ticks: merge data in place, keep every live position.
  useEffect(() => {
    if (!evaluation) return;
    const fresh = buildGraph(docRef.current, evaluation, issuesRef.current);
    setNodes((prev) =>
      reconcileNodes(prev, fresh.nodes, {
        preferLivePositions: true,
        draggingId: draggingId.current,
      }),
    );
    setEdges((prev) => reconcileEdges(prev, fresh.edges));
  }, [evaluation]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          const p = useBuilderStore.getState().doc.positions[change.id];
          setPosition(change.id, { ...p, ...change.position });
        }
        // NodeResizer gesture: track live, persist the size at gesture end so
        // eval-tick rebuilds can't snap a node mid-resize.
        if (change.type === "dimensions") {
          if (change.resizing) {
            draggingId.current = change.id;
            if (change.dimensions) {
              resizeLast.current = { id: change.id, ...change.dimensions };
            }
          } else if (change.resizing === false) {
            draggingId.current = null;
            const final =
              change.dimensions ??
              (resizeLast.current?.id === change.id
                ? { width: resizeLast.current.width, height: resizeLast.current.height }
                : null);
            if (final) {
              const xy = useBuilderStore.getState().doc.positions[change.id] ??
                nodesRef.current.find((n) => n.id === change.id)?.position ?? { x: 0, y: 0 };
              setPosition(change.id, { x: xy.x, y: xy.y, w: final.width, h: final.height });
            }
            resizeLast.current = null;
          }
        }
        if (
          change.type === "select" &&
          change.selected &&
          useBuilderStore.getState().doc.selectedNodeId !== change.id
        ) {
          select(change.id);
          const store = useBuilderStore.getState();
          if (change.id.startsWith("market:")) {
            // Market blocks route to their live preview…
            store.focusMarket(change.id.slice("market:".length));
            store.setActiveTab("market");
          } else {
            // …every other block opens its details/editor in the Block tab.
            store.setActiveTab("block");
          }
        }
        if (change.type === "select" && !change.selected) {
          const store = useBuilderStore.getState();
          if (store.doc.selectedNodeId === change.id && store.activeTab === "block") {
            store.setActiveTab(store.lastNonBlockTab);
          }
        }
      }
    },
    [select, setPosition],
  );

  return (
    <div
      className="h-full min-h-[420px] w-full rounded-xl border border-border bg-surface-2/50"
      data-tour="builder-canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_, node) => {
          draggingId.current = node.id;
        }}
        onNodeDragStop={() => {
          draggingId.current = null;
        }}
        onPaneClick={() => select(null)}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        // Keyboard delete works on blocks; React Flow already ignores it while
        // an input has focus. Root, action and referenced markets are guarded.
        deleteKeyCode={["Backspace", "Delete"]}
        onBeforeDelete={async ({ nodes: toDelete }) => {
          const d = docRef.current;
          const allowed = toDelete.filter((n) => {
            if (n.id === "root" || n.id === "action") return false;
            if (n.id.startsWith("market:")) {
              return !isTokenReferenced(d, n.id.slice("market:".length));
            }
            return true;
          });
          return allowed.length > 0 ? { nodes: allowed, edges: [] } : false;
        }}
        onNodesDelete={(deleted) => {
          const store = useBuilderStore.getState();
          for (const n of deleted) {
            if (n.id.startsWith("market:")) {
              store.removeWatchedMarket(n.id.slice("market:".length));
            } else {
              store.removeNode(n.id);
            }
          }
        }}
      >
        <Background gap={24} size={1.5} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
