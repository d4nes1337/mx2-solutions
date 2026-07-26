import { describe, expect, it } from "vitest";
import type {
  ConditionV2,
  ExprNode,
  ExprResultNode,
  GroupNode,
  MarketRef,
  OrderActionV2,
} from "@mx2/rules";
import { emptyDoc, type StrategyDoc } from "./doc";
import { collectConditionResults, docToGrid, isComplexDoc } from "./grid-projection";

const market = (n: number): MarketRef => ({
  conditionId: `cond-${n}`,
  tokenId: `tok-${n}`,
  outcome: "YES",
  title: `Market ${n}`,
});

const price = (m: MarketRef, threshold = 0.67): ConditionV2 => ({
  kind: "price",
  market: m,
  source: "ask",
  comparator: "gte",
  threshold,
});

const timeWindow = (): ConditionV2 => ({ kind: "time_window", startMs: null, endMs: null });

let seq = 0;
const cond = (c: ConditionV2): ExprNode => ({ type: "condition", id: `n${++seq}`, condition: c });
const group = (op: GroupNode["op"], children: ExprNode[]): GroupNode => ({
  type: "group",
  id: `g${++seq}`,
  op,
  children,
});

const doc = (children: ExprNode[], rootOp: "and" | "or" = "and"): StrategyDoc => ({
  ...emptyDoc(),
  expr: { type: "group", id: "root", op: rootOp, children },
});

const orderAction = (m: MarketRef): OrderActionV2 => ({
  kind: "order",
  market: m,
  side: "BUY",
  price: 0.57,
  size: 100,
  orderType: "GTC",
  execution: "prepare",
});

/** Total condition leaves reachable in the projection (cards + guards + complex). */
const projectedLeafCount = (d: StrategyDoc): number => {
  const p = docToGrid(d);
  const inComplex = p.complex.reduce((acc, { node }) => {
    const walk = (n: ExprNode): number =>
      n.type === "condition" ? 1 : n.children.reduce((a, c) => a + walk(c), 0);
    return acc + walk(node);
  }, 0);
  return (
    p.watch.reduce((acc, c) => acc + c.rows.length, 0) + p.guards.length + inComplex
  );
};

describe("docToGrid — classification", () => {
  it("projects flat conditions into per-market cards mirroring the root op", () => {
    const m1 = market(1);
    const m2 = market(2);
    const d = doc([cond(price(m1, 0.67)), cond(price(m1, 0.4)), cond(price(m2))], "or");
    const p = docToGrid(d);
    expect(p.rootOp).toBe("or");
    expect(p.complex).toHaveLength(0);
    expect(p.watch.map((c) => c.key)).toEqual(["tok-1", "tok-2"]);
    const card1 = p.watch[0]!;
    expect(card1.rows).toHaveLength(2);
    expect(card1.op).toBe("or"); // flat rows inherit the root op
    expect(card1.opNodeId).toBeNull();
    expect(card1.market?.title).toBe("Market 1");
  });

  it("projects a qualifying per-market group as a card with its own op (two-level logic)", () => {
    const m1 = market(1);
    const m2 = market(2);
    const g1 = group("and", [cond(price(m1, 0.67)), cond(price(m1, 0.6))]);
    const d = doc([g1, cond(price(m2))], "or");
    const p = docToGrid(d);
    expect(p.complex).toHaveLength(0);
    const card1 = p.watch.find((c) => c.key === "tok-1")!;
    expect(card1.op).toBe("and");
    expect(card1.opNodeId).toBe(g1.id);
    expect(card1.rows).toHaveLength(2);
    expect(p.rootOp).toBe("or");
  });

  it("classifies NOT groups, nested groups and mixed-market groups as complex", () => {
    const m1 = market(1);
    const m2 = market(2);
    const notG = group("not", [cond(price(m1))]);
    const nested = group("and", [group("or", [cond(price(m1))])]);
    const mixed = group("and", [cond(price(m1)), cond(price(m2))]);
    const p = docToGrid(doc([notG, nested, mixed]));
    expect(p.complex.map((c) => c.node.id).sort()).toEqual([mixed.id, nested.id, notG.id].sort());
    expect(p.watch).toHaveLength(0);
  });

  it("demotes a same-market group to complex when flat rows also exist (ambiguous write-back)", () => {
    const m1 = market(1);
    const g1 = group("or", [cond(price(m1, 0.7)), cond(price(m1, 0.3))]);
    const p = docToGrid(doc([cond(price(m1, 0.5)), g1]));
    expect(p.complex.map((c) => c.node.id)).toEqual([g1.id]);
    const card = p.watch[0]!;
    expect(card.rows).toHaveLength(1);
    expect(card.opNodeId).toBeNull();
  });

  it("keeps the first of several qualifying groups for one market; demotes the rest", () => {
    const m1 = market(1);
    const g1 = group("and", [cond(price(m1, 0.7))]);
    const g2 = group("or", [cond(price(m1, 0.3))]);
    const p = docToGrid(doc([g1, g2]));
    expect(p.watch[0]!.opNodeId).toBe(g1.id);
    expect(p.complex.map((c) => c.node.id)).toEqual([g2.id]);
  });

  it("routes time-window conditions to the time pseudo-card and unbound to the placeholder card", () => {
    const p = docToGrid(
      doc([
        cond(timeWindow()),
        cond(price({ conditionId: "", tokenId: "", outcome: "YES" })),
      ]),
    );
    expect(p.watch.map((c) => c.key).sort()).toEqual(["time", "unbound"]);
    expect(p.watch.every((c) => c.market === null)).toBe(true);
  });
});

describe("docToGrid — guards and placeholders", () => {
  it("moves conditions bound to the order's target market into guards", () => {
    const m1 = market(1);
    const target = market(9);
    const d: StrategyDoc = {
      ...doc([cond(price(m1)), cond(price(target, 0.6))]),
      action: orderAction(target),
    };
    const p = docToGrid(d);
    expect(p.watch.map((c) => c.key)).toEqual(["tok-1"]);
    expect(p.guards).toHaveLength(1);
    expect(p.guards[0]!.condition.kind).toBe("price");
    expect(p.guardsOpNodeId).toBeNull();
  });

  it("carries the guard group's own op when the target conditions were grouped", () => {
    const target = market(9);
    const g = group("or", [cond(price(target, 0.6)), cond(price(target, 0.4))]);
    const d: StrategyDoc = { ...doc([g, cond(price(market(1)))]), action: orderAction(target) };
    const p = docToGrid(d);
    expect(p.guards).toHaveLength(2);
    expect(p.guardsOp).toBe("or");
    expect(p.guardsOpNodeId).toBe(g.id);
  });

  it("renders unreferenced watched markets as placeholder cards, excluding the target", () => {
    const target = market(9);
    const watched = market(5);
    const d: StrategyDoc = {
      ...doc([cond(price(market(1)))]),
      action: orderAction(target),
      watchedMarkets: [watched, target],
    };
    const p = docToGrid(d);
    const placeholder = p.watch.find((c) => c.key === "tok-5");
    expect(placeholder?.placeholder).toBe(true);
    expect(placeholder?.rows).toHaveLength(0);
    expect(p.watch.some((c) => c.key === "tok-9")).toBe(false);
  });
});

describe("docToGrid — invariants", () => {
  it("classifies every condition leaf exactly once (coverage invariant)", () => {
    const m1 = market(1);
    const m2 = market(2);
    const target = market(9);
    const d: StrategyDoc = {
      ...doc(
        [
          cond(price(m1)),
          group("and", [cond(price(m2, 0.7)), cond(price(m2, 0.2))]),
          group("not", [cond(price(m1, 0.9))]),
          group("and", [cond(price(m1, 0.1)), cond(price(m2, 0.9))]),
          cond(timeWindow()),
          cond(price(target, 0.6)),
        ],
        "or",
      ),
      action: orderAction(target),
    };
    expect(projectedLeafCount(d)).toBe(8);
  });

  it("does not mutate the doc", () => {
    const d = doc([cond(price(market(1))), group("not", [cond(price(market(2)))])]);
    const before = JSON.stringify(d);
    docToGrid(d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("isComplexDoc flags exactly the docs with grid-uneditable logic", () => {
    expect(isComplexDoc(doc([cond(price(market(1)))]))).toBe(false);
    expect(isComplexDoc(doc([group("and", [cond(price(market(1)))])]))).toBe(false);
    expect(isComplexDoc(doc([group("not", [cond(price(market(1)))])]))).toBe(true);
  });
});

describe("collectConditionResults", () => {
  it("flattens nested result trees into per-node readings", () => {
    const tree: ExprResultNode = {
      type: "group",
      id: "root",
      op: "and",
      satisfied: false,
      children: [
        {
          type: "condition",
          id: "a",
          satisfied: true,
          result: {
            kind: "price",
            satisfied: true,
            actual: 0.68,
            threshold: 0.67,
            reason: "PRICE_OK" as never,
            tokenId: "tok-1",
            stale: false,
          },
        },
        {
          type: "group",
          id: "g",
          op: "or",
          satisfied: false,
          children: [
            {
              type: "condition",
              id: "b",
              satisfied: false,
              result: {
                kind: "price",
                satisfied: false,
                actual: null,
                threshold: 0.5,
                reason: "DATA_STALE" as never,
                tokenId: "tok-2",
                stale: true,
              },
            },
          ],
        },
      ],
    };
    const m = collectConditionResults(tree);
    expect(m.get("a")).toEqual({ satisfied: true, stale: false, actual: 0.68 });
    expect(m.get("b")).toEqual({ satisfied: false, stale: true, actual: null });
    expect(collectConditionResults(null).size).toBe(0);
  });
});
