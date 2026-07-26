/**
 * Builder store invariants for the canvas-multitool rework: group/nested adds,
 * editor-only state never retriggering evaluation, and manual node sizes
 * riding along with positions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { useBuilderStore } from "./store";
import { emptyDoc, UNBOUND } from "./doc";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };

const orderAction = () =>
  ({
    kind: "order",
    market: UNBOUND,
    side: "BUY",
    price: 0.5,
    size: 10,
    orderType: "GTC",
    execution: "prepare",
  }) as const;

const priceCondition = {
  kind: "price",
  market,
  source: "ask",
  comparator: "lte",
  threshold: 0.5,
} as const;

beforeEach(() => {
  useBuilderStore.getState().reset(emptyDoc());
});

describe("useBuilderStore: order price anchors to fresh market context (§8.1.5)", () => {
  it("snaps a new order's limit price to the picked outcome's current price on bind", () => {
    const store = useBuilderStore.getState();
    store.setAction(orderAction());
    store.bindMarket("action", market, { title: "T", currentPrice: 0.37 });
    const a = useBuilderStore.getState().doc.action;
    expect(a.kind).toBe("order");
    if (a.kind === "order") {
      expect(a.price).toBe(0.37);
      expect(a.market.tokenId).toBe("tok-1");
    }
  });

  it("clamps an extreme current price into the valid tick band", () => {
    const store = useBuilderStore.getState();
    store.setAction(orderAction());
    store.bindMarket("action", market, { title: "T", currentPrice: 0.997 });
    const a = useBuilderStore.getState().doc.action;
    if (a.kind === "order") expect(a.price).toBe(0.99);
  });

  it("leaves the price unchanged when the market has no current price", () => {
    const store = useBuilderStore.getState();
    store.setAction(orderAction());
    store.bindMarket("action", market, { title: "T" });
    const a = useBuilderStore.getState().doc.action;
    if (a.kind === "order") expect(a.price).toBe(0.5);
  });
});

describe("useBuilderStore: groups and nesting", () => {
  it("addGroup appends an empty group to the root and selects it", () => {
    const store = useBuilderStore.getState();
    const before = useBuilderStore.getState().revision;
    const id = store.addGroup("or");
    const s = useBuilderStore.getState();
    const group = s.doc.expr.children.find((n) => n.id === id);
    expect(group).toMatchObject({ type: "group", op: "or", children: [] });
    expect(s.doc.selectedNodeId).toBe(id);
    expect(s.revision).toBe(before + 1); // structural change → re-evaluate
  });

  it("addCondition with parentId nests inside the group", () => {
    const store = useBuilderStore.getState();
    const groupId = store.addGroup("and");
    const condId = useBuilderStore.getState().addCondition(priceCondition, groupId);
    const s = useBuilderStore.getState();
    const group = s.doc.expr.children.find((n) => n.id === groupId);
    expect(group?.type).toBe("group");
    if (group?.type !== "group") return;
    expect(group.children.map((c) => c.id)).toEqual([condId]);
    expect(s.doc.expr.children.some((n) => n.id === condId)).toBe(false); // not at root
  });

  it("addCondition with an unknown parent falls back to the root", () => {
    const condId = useBuilderStore.getState().addCondition(priceCondition, "nope");
    expect(useBuilderStore.getState().doc.expr.children.map((n) => n.id)).toContain(condId);
  });

  it("moveNode reparents with revision bump; refusals don't bump", () => {
    const store = useBuilderStore.getState();
    const groupId = store.addGroup("or");
    const condId = useBuilderStore.getState().addCondition(priceCondition);
    useBuilderStore.getState().setPosition(condId, { x: 7, y: 8 });
    const before = useBuilderStore.getState().revision;

    useBuilderStore.getState().moveNode(condId, groupId);
    let s = useBuilderStore.getState();
    expect(s.revision).toBe(before + 1);
    const g = s.doc.expr.children.find((n) => n.id === groupId);
    expect(g?.type === "group" && g.children.some((c) => c.id === condId)).toBe(true);
    // Identity preserved → the node keeps its persisted position.
    expect(s.doc.positions[condId]).toEqual({ x: 7, y: 8 });

    // Refused move (into itself) → no revision bump.
    useBuilderStore.getState().moveNode(groupId, groupId);
    s = useBuilderStore.getState();
    expect(s.revision).toBe(before + 1);
  });
});

describe("useBuilderStore: editor-only state", () => {
  it("selection, tabs and positions never bump the revision", () => {
    const store = useBuilderStore.getState();
    const condId = store.addCondition(priceCondition);
    const before = useBuilderStore.getState().revision;

    useBuilderStore.getState().select(condId);
    useBuilderStore.getState().setActiveTab("block");
    useBuilderStore.getState().setPosition(condId, { x: 10, y: 20, w: 340, h: 500 });
    expect(useBuilderStore.getState().revision).toBe(before);
  });

  it("positions round-trip manual sizes (expand / resize)", () => {
    const store = useBuilderStore.getState();
    const condId = store.addCondition(priceCondition);
    useBuilderStore.getState().setPosition(condId, { x: 5, y: 6, w: 340, h: 500 });
    expect(useBuilderStore.getState().doc.positions[condId]).toEqual({
      x: 5,
      y: 6,
      w: 340,
      h: 500,
    });
    // Collapse: writing without w/h clears the manual size.
    useBuilderStore.getState().setPosition(condId, { x: 5, y: 6 });
    expect(useBuilderStore.getState().doc.positions[condId]).toEqual({ x: 5, y: 6 });
  });

  it("the Block tab remembers where to return on deselect", () => {
    useBuilderStore.getState().setActiveTab("simulate");
    useBuilderStore.getState().setActiveTab("block");
    const s = useBuilderStore.getState();
    expect(s.activeTab).toBe("block");
    expect(s.lastNonBlockTab).toBe("simulate");
  });

  it("aiStatus starts idle and transitions without bumping the revision", () => {
    expect(useBuilderStore.getState().aiStatus).toBe("idle");
    const before = useBuilderStore.getState().revision;

    useBuilderStore.getState().setAiStatus("drafting");
    expect(useBuilderStore.getState().aiStatus).toBe("drafting");
    useBuilderStore.getState().setAiStatus("error");
    expect(useBuilderStore.getState().aiStatus).toBe("error");
    useBuilderStore.getState().setAiStatus("idle");
    expect(useBuilderStore.getState().aiStatus).toBe("idle");

    expect(useBuilderStore.getState().revision).toBe(before);
  });
});

describe("useBuilderStore.setCardOp: two-level grid logic", () => {
  const price = (tokenId: string, threshold: number) =>
    ({
      kind: "price",
      market: { conditionId: `c-${tokenId}`, tokenId, outcome: "YES" },
      source: "ask",
      comparator: "gte",
      threshold,
    }) as const;

  it("materializes a per-market group from flat root rows, preserving node ids", () => {
    const store = useBuilderStore.getState();
    const a = store.addCondition(price("tok-1", 0.6));
    const b = store.addCondition(price("tok-1", 0.4));
    const other = store.addCondition(price("tok-2", 0.5));

    store.setCardOp("tok-1", "or"); // root op is "and" → differs → group

    const root = useBuilderStore.getState().doc.expr;
    expect(root.children).toHaveLength(2);
    const group = root.children.find((n) => n.type === "group");
    expect(group?.type).toBe("group");
    if (group?.type !== "group") return;
    expect(group.op).toBe("or");
    expect(group.children.map((c) => c.id)).toEqual([a, b]);
    expect(root.children.some((n) => n.id === other)).toBe(true);
  });

  it("flips an existing backing group's op in place", () => {
    const store = useBuilderStore.getState();
    store.addCondition(price("tok-1", 0.6));
    store.addCondition(price("tok-1", 0.4));
    store.setCardOp("tok-1", "or");
    const groupId = useBuilderStore
      .getState()
      .doc.expr.children.find((n) => n.type === "group")!.id;

    useBuilderStore.getState().setCardOp("tok-1", "and");

    const group = useBuilderStore.getState().doc.expr.children.find((n) => n.type === "group");
    expect(group?.id).toBe(groupId); // same node, op flipped
    expect(group?.type === "group" && group.op).toBe("and");
  });

  it("keeps flat rows flat when the requested op matches the root op", () => {
    const store = useBuilderStore.getState();
    store.addCondition(price("tok-1", 0.6));
    store.addCondition(price("tok-1", 0.4));
    const before = useBuilderStore.getState().doc.expr;

    useBuilderStore.getState().setCardOp("tok-1", "and"); // root is already "and"

    expect(useBuilderStore.getState().doc.expr).toBe(before);
  });

  it("ignores single-row cards (nothing to combine)", () => {
    const store = useBuilderStore.getState();
    store.addCondition(price("tok-1", 0.6));
    const before = useBuilderStore.getState().doc.expr;

    useBuilderStore.getState().setCardOp("tok-1", "or");

    expect(useBuilderStore.getState().doc.expr).toBe(before);
  });
});

describe("useBuilderStore: AI apply undo", () => {
  it("markAiApplied + undoAiApply restore the pre-AI doc and clear the flash ids", () => {
    const store = useBuilderStore.getState();
    store.addCondition({
      kind: "price",
      market: { conditionId: "c", tokenId: "t", outcome: "YES" },
      source: "ask",
      comparator: "lte",
      threshold: 0.4,
    });
    const before = useBuilderStore.getState().doc;

    store.reset({ ...before, name: "AI version" });
    useBuilderStore.getState().markAiApplied(before, ["x1"]);
    expect(useBuilderStore.getState().lastAiChangedIds).toEqual(["x1"]);

    useBuilderStore.getState().undoAiApply();
    expect(useBuilderStore.getState().doc.name).toBe(before.name);
    expect(useBuilderStore.getState().aiUndo).toBeNull();
    expect(useBuilderStore.getState().lastAiChangedIds).toEqual([]);
  });
});
