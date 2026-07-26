/** Quick-edit surgery: targeted, immutable, and blind to non-price leaves. */
import { describe, it, expect } from "vitest";
import { applyDefinitionEdits } from "./edit-definition";
import type { StrategyDefinition } from "@mx2/rules";

const def: StrategyDefinition = {
  version: 2,
  name: "s",
  templateId: null,
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "p1",
        condition: {
          kind: "price",
          market: { conditionId: "c", tokenId: "t", outcome: "YES" },
          source: "ask",
          comparator: "lte",
          threshold: 0.5,
        },
      },
      {
        type: "group",
        id: "g1",
        op: "or",
        children: [
          {
            type: "condition",
            id: "p2",
            condition: {
              kind: "price",
              market: { conditionId: "c2", tokenId: "t2", outcome: "YES" },
              source: "bid",
              comparator: "gte",
              threshold: 0.6,
            },
          },
          {
            type: "condition",
            id: "tw",
            condition: { kind: "time_window", startMs: null, endMs: null },
          },
        ],
      },
    ],
  },
  holdsForMs: 600_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: { conditionId: "c", tokenId: "t", outcome: "YES" },
    side: "BUY",
    price: 0.49,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

const leafThreshold = (d: StrategyDefinition, id: string): number | null => {
  let found: number | null = null;
  const walk = (n: StrategyDefinition["expr"]): void => {
    if (n.type === "condition") {
      if (n.id === id && n.condition.kind === "price") found = n.condition.threshold;
      return;
    }
    n.children.forEach(walk);
  };
  walk(d.expr);
  return found;
};

describe("applyDefinitionEdits", () => {
  it("swaps only the targeted nested threshold", () => {
    const next = applyDefinitionEdits(def, { thresholds: { p2: 0.65 } });
    expect(leafThreshold(next, "p2")).toBeCloseTo(0.65, 9);
    expect(leafThreshold(next, "p1")).toBeCloseTo(0.5, 9);
    expect(def.expr).not.toBe(next.expr); // fresh tree
    expect(leafThreshold(def, "p2")).toBeCloseTo(0.6, 9); // input untouched
  });

  it("edits the order price and size without touching the rest", () => {
    const next = applyDefinitionEdits(def, { orderPrice: 0.44, orderSize: 250 });
    expect(next.action.kind).toBe("order");
    if (next.action.kind === "order") {
      expect(next.action.price).toBeCloseTo(0.44, 9);
      expect(next.action.size).toBe(250);
      expect(next.action.orderType).toBe("GTC");
    }
    expect(next.holdsForMs).toBe(def.holdsForMs);
    expect(next.expr).toBe(def.expr); // untouched tree keeps identity
  });

  it("ignores threshold edits addressed to non-price leaves", () => {
    const next = applyDefinitionEdits(def, { thresholds: { tw: 0.2 } });
    expect(leafThreshold(next, "p1")).toBeCloseTo(0.5, 9);
    expect(leafThreshold(next, "p2")).toBeCloseTo(0.6, 9);
  });

  it("no edits → structurally identical definition", () => {
    const next = applyDefinitionEdits(def, {});
    expect(next.expr).toBe(def.expr);
    expect(next.action).toBe(def.action);
  });
});
