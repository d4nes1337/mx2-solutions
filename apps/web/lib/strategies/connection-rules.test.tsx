/**
 * Canvas wiring legality: moveNodeInTree guards (identity preservation, depth,
 * NOT arity, subtree, collapse) and the pure connection/drop verdicts.
 */
import { describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { dropTargetFor, validateConnection } from "./connection-rules";
import { UNBOUND, emptyDoc, moveNodeInTree, type StrategyDoc } from "./doc";
import type { ExprNode, GroupNode } from "@mx2/rules";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };

const cond = (id: string): ExprNode => ({
  type: "condition",
  id,
  condition: { kind: "price", market, source: "ask", comparator: "lte", threshold: 0.5 },
});

const timeCond = (id: string): ExprNode => ({
  type: "condition",
  id,
  condition: { kind: "time_window", startMs: null, endMs: null },
});

const group = (id: string, op: "and" | "or" | "not", children: ExprNode[]): GroupNode => ({
  type: "group",
  id,
  op,
  children,
});

const docWith = (expr: GroupNode, over: Partial<StrategyDoc> = {}): StrategyDoc => ({
  ...emptyDoc(),
  expr,
  ...over,
});

describe("moveNodeInTree", () => {
  it("moves a root condition into a group, preserving every node id", () => {
    const root = group("root", "and", [cond("c1"), group("g1", "or", [cond("c2")])]);
    const out = moveNodeInTree(root, "c1", "g1");
    expect(out).not.toBe(root);
    const g1 = out.children.find((n) => n.id === "g1");
    expect(g1?.type).toBe("group");
    if (g1?.type !== "group") return;
    expect(g1.children.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(out.children.map((n) => n.id)).toEqual(["g1"]);
  });

  it("moves a nested condition back to the root; emptied group collapses", () => {
    const root = group("root", "and", [group("g1", "or", [cond("c1")])]);
    const out = moveNodeInTree(root, "c1", "root");
    expect(out.children.map((n) => n.id)).toEqual(["c1"]); // g1 collapsed away
  });

  it("refuses NOT groups as targets", () => {
    const root = group("root", "and", [cond("c1"), group("n1", "not", [cond("c2")])]);
    expect(moveNodeInTree(root, "c1", "n1")).toBe(root);
  });

  it("refuses moving a group into its own subtree and self/root moves", () => {
    const inner = group("g2", "or", [cond("c1")]);
    const root = group("root", "and", [group("g1", "and", [inner])]);
    expect(moveNodeInTree(root, "g1", "g2")).toBe(root);
    expect(moveNodeInTree(root, "g1", "g1")).toBe(root);
    expect(moveNodeInTree(root, "root", "g1")).toBe(root);
  });

  it("refuses moves that exceed the depth cap", () => {
    // root → g1 → c1 is depth 3 (max). Moving g2 (containing c2) under g1
    // would make root → g1 → g2 → c2 = depth 4.
    const root = group("root", "and", [
      group("g1", "and", [cond("c1")]),
      group("g2", "or", [cond("c2")]),
    ]);
    expect(moveNodeInTree(root, "g2", "g1")).toBe(root);
  });

  it("no-ops (same reference) when already a direct child of the target", () => {
    const root = group("root", "and", [group("g1", "or", [cond("c1")])]);
    expect(moveNodeInTree(root, "c1", "g1")).toBe(root);
  });
});

describe("validateConnection", () => {
  const base = docWith(
    group("root", "and", [
      cond("c1"),
      timeCond("t1"),
      group("g1", "or", [cond("c2")]),
      group("n1", "not", [cond("c3")]),
    ]),
  );

  const conn = (source: string, target: string) => ({
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  });

  it("allows market → condition, refuses time windows", () => {
    expect(validateConnection(base, conn("market:tok-1", "c1")).ok).toBe(true);
    const t = validateConnection(base, conn("market:tok-1", "t1"));
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toMatch(/time window/i);
  });

  it("market → action only for order actions, with kind-specific reasons", () => {
    const orderDoc = docWith(base.expr, {
      action: {
        kind: "order",
        market: UNBOUND,
        side: "BUY",
        price: 0.5,
        size: 10,
        orderType: "GTC",
        execution: "prepare",
      },
    });
    expect(validateConnection(orderDoc, conn("market:tok-1", "action")).ok).toBe(true);

    const farmDoc = docWith(base.expr, {
      action: {
        kind: "quote_loop",
        market: { conditionId: "", yesTokenId: "", noTokenId: "" },
        sizeShares: 50,
        targetSpreadCents: 2,
        requoteToleranceCents: 1,
        maxInventoryShares: 100,
        maxCapitalUsd: 60,
        maxDailyLossUsd: 10,
      },
    });
    const farm = validateConnection(farmDoc, conn("market:tok-1", "action"));
    expect(farm.ok).toBe(false);
    if (!farm.ok) expect(farm.reason).toMatch(/farm/i);

    const alert = validateConnection(base, conn("market:tok-1", "action"));
    expect(alert.ok).toBe(false);
  });

  it("allows condition → group / root, refuses NOT and root→action", () => {
    expect(validateConnection(base, conn("c1", "g1")).ok).toBe(true);
    expect(validateConnection(base, conn("c2", "root")).ok).toBe(true);
    expect(validateConnection(base, conn("c1", "n1")).ok).toBe(false);
    expect(validateConnection(base, conn("root", "action")).ok).toBe(false);
    expect(validateConnection(base, conn("c1", "action")).ok).toBe(false);
  });

  it("refuses no-op nesting with a friendly reason", () => {
    const v = validateConnection(base, conn("c2", "g1"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/already inside/i);
  });
});

describe("dropTargetFor", () => {
  const doc = docWith(group("root", "and", [cond("c1"), timeCond("t1")]), {
    action: {
      kind: "order",
      market: UNBOUND,
      side: "BUY",
      price: 0.5,
      size: 10,
      orderType: "GTC",
      execution: "prepare",
    },
  });

  it("picks the first bindable hit, skipping time windows and markets", () => {
    expect(dropTargetFor(doc, "tok-1", ["market:x", "t1", "c1", "action"])).toBe("c1");
    expect(dropTargetFor(doc, "tok-1", ["t1", "action"])).toBe("action");
    expect(dropTargetFor(doc, "tok-1", ["t1", "root"])).toBeNull();
  });

  it("skips the action when it is not an order", () => {
    const alertDoc = docWith(doc.expr); // emptyDoc action = alert
    expect(dropTargetFor(alertDoc, "tok-1", ["action"])).toBeNull();
  });
});
