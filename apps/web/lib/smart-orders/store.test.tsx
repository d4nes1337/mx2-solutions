/**
 * Builder store invariants for the canvas-multitool rework: group/nested adds,
 * editor-only state never retriggering evaluation, and manual node sizes
 * riding along with positions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { useBuilderStore } from "./store";
import { emptyDoc } from "./doc";

const market: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" };

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
});
