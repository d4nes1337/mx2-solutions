"use client";

/**
 * The node canvas: projects the StrategyDoc (plus live evaluation results)
 * into React Flow nodes/edges. Structure is derived — edges always mirror the
 * expression tree — while positions and selection flow back into the store.
 * Loaded via next/dynamic so React Flow never enters other routes' bundles.
 */
import { useCallback, useMemo, useRef } from "react";
import {
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
      return cents(actual);
    case "cumulative_notional":
      return usd(Math.round(actual));
    case "visible_levels":
      return String(actual);
    case "time_window":
      return null;
  }
};

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

  // Staged reveal: for ~2.5s after the AI replaces the doc, nodes mount with a
  // cascading entrance (CSS animation, reduced-motion-gated in globals.css).
  const revealRef = useRef({ tick: 0, at: 0 });
  if (revealTick !== revealRef.current.tick) {
    revealRef.current = { tick: revealTick, at: Date.now() };
  }

  const { nodes, edges } = useMemo(() => {
    const results = new Map<string, ExprResultNode>();
    indexResults(evaluation?.root, results);
    const freshness = new Map(evaluation?.markets.map((m) => [m.tokenId, m]) ?? []);
    const issueFor = (nodeId: string) => issues.find((i) => i.nodeId === nodeId)?.message ?? null;

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const pos = (id: string, fx: number, fy: number) => doc.positions[id] ?? { x: fx, y: fy };

    // Market nodes.
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

    if (revealTick > 0 && Date.now() - revealRef.current.at < 2_500) {
      nodes.forEach((n, i) => {
        n.className = "node-reveal";
        n.style = { ...n.style, animationDelay: `${i * 70}ms` };
      });
    }

    return { nodes, edges };
  }, [doc, evaluation, issues, revealTick]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          setPosition(change.id, change.position);
        }
        if (change.type === "select" && change.selected) select(change.id);
      }
    },
    [select, setPosition],
  );

  return (
    <div className="h-[520px] w-full rounded-xl border border-border bg-surface-2/50">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onPaneClick={() => select(null)}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background gap={24} size={1.5} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
