/**
 * Proximity ranking: leaf distances mirror evaluate-v2 semantics, the tree
 * fold takes the binding constraint (AND=max, OR=min), gates never fake a
 * cents distance, dwell-in-progress always outranks any waiting strategy, and
 * normalization makes "close" mean "close for THIS market's usual speed".
 */
import { describe, it, expect } from "vitest";
import { PROXIMITY, recentDrift, strategyProximity, typicalMovement } from "./proximity.js";
import type { MarketDataView, PriceSample } from "./types.js";
import type {
  ConditionV2,
  ExprNode,
  MarketRef,
  StrategyDefinition,
  ViewsByToken,
} from "./types-v2.js";

const marketA: MarketRef = { conditionId: "CA", tokenId: "TA", outcome: "YES" };
const marketB: MarketRef = { conditionId: "CB", tokenId: "TB", outcome: "YES" };

const NOW = 1_000_000;

const viewAt = (
  market: MarketRef,
  bid: number,
  ask = bid + 0.02,
  over: Partial<MarketDataView> = {},
): MarketDataView => ({
  tokenId: market.tokenId,
  conditionId: market.conditionId,
  asks: [{ price: ask, size: 1_000 }],
  bids: [{ price: bid, size: 1_000 }],
  marketStatus: "open",
  sourceTimeMs: NOW,
  receivedAtMs: NOW,
  ...over,
});

let nextId = 0;
const leaf = (condition: ConditionV2, id = `c${++nextId}`): ExprNode => ({
  type: "condition",
  id,
  condition,
});

const group = (op: "and" | "or" | "not", children: ExprNode[], id = `g${++nextId}`): ExprNode => ({
  type: "group",
  id,
  op,
  children,
});

const priceLeaf = (
  threshold: number,
  over: Partial<Extract<ConditionV2, { kind: "price" }>> = {},
  id?: string,
): ExprNode =>
  leaf(
    { kind: "price", market: marketA, source: "ask", comparator: "lte", threshold, ...over },
    id,
  );

const strat = (expr: ExprNode, over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  version: 2,
  name: "proximity-test",
  templateId: null,
  expr,
  holdsForMs: 0,
  maxDataAgeMs: 60_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const views = (bid = 0.38, ask = 0.4): ViewsByToken => ({ TA: viewAt(marketA, bid, ask) });

describe("strategyProximity: price leaves", () => {
  it("satisfied leaf ranks 0 with distance 0", () => {
    const p = strategyProximity(strat(priceLeaf(0.45)), views(), NOW);
    expect(p.rank).toBe(0);
    expect(p.bindingDistance).toBe(0);
    expect(p.blockedBy).toEqual([]);
  });

  it("buy-side lte measures ask − threshold, normalized by the default move", () => {
    const p = strategyProximity(strat(priceLeaf(0.34)), views(0.38, 0.4), NOW);
    expect(p.bindingDistance).toBeCloseTo(0.06, 9);
    expect(p.rank).toBeCloseTo(0.06 / PROXIMITY.defaultTypicalMove, 9);
    expect(p.bindingTokenId).toBe("TA");
  });

  it("sell-side gte measures threshold − bid", () => {
    const expr = priceLeaf(0.6, { source: "bid", comparator: "gte" });
    const p = strategyProximity(strat(expr), views(0.55), NOW);
    expect(p.bindingDistance).toBeCloseTo(0.05, 9);
  });

  it("normalization ranks the fast market ahead for the same raw distance", () => {
    const def = strat(priceLeaf(0.34));
    const fast = strategyProximity(def, views(0.38, 0.4), NOW, {
      typicalMoveByToken: { TA: 0.05 },
    });
    const slow = strategyProximity(def, views(0.38, 0.4), NOW, {
      typicalMoveByToken: { TA: 0.005 },
    });
    expect(fast.rank).toBeLessThan(slow.rank);
    expect(fast.bindingDistance).toBeCloseTo(slow.bindingDistance!, 9);
  });

  it("typical-move floor prevents divide-by-tiny", () => {
    const p = strategyProximity(strat(priceLeaf(0.34)), views(0.38, 0.4), NOW, {
      typicalMoveByToken: { TA: 0.0001 },
    });
    expect(p.rank).toBeCloseTo(0.06 / PROXIMITY.minTypicalMove, 9);
  });
});

describe("strategyProximity: tree fold", () => {
  it("AND binds on the worst child", () => {
    const near = priceLeaf(0.38, {}, "near"); // ask 0.40 → 0.02 away
    const far = priceLeaf(0.34, {}, "far"); // 0.06 away
    const p = strategyProximity(strat(group("and", [near, far])), views(), NOW);
    expect(p.bindingNodeId).toBe("far");
    expect(p.bindingDistance).toBeCloseTo(0.06, 9);
  });

  it("OR binds on the best child", () => {
    const near = priceLeaf(0.38, {}, "near");
    const far = priceLeaf(0.34, {}, "far");
    const p = strategyProximity(strat(group("or", [near, far])), views(), NOW);
    expect(p.bindingNodeId).toBe("near");
    expect(p.bindingDistance).toBeCloseTo(0.02, 9);
  });

  it("nested AND(OR(near, far), mid) folds through", () => {
    const near = priceLeaf(0.38, {}, "near"); // 0.02
    const far = priceLeaf(0.3, {}, "far"); // 0.10
    const mid = priceLeaf(0.36, {}, "mid"); // 0.04
    const p = strategyProximity(strat(group("and", [group("or", [near, far]), mid])), views(), NOW);
    // OR resolves to 0.02; AND takes max(0.02, 0.04).
    expect(p.bindingNodeId).toBe("mid");
    expect(p.bindingDistance).toBeCloseTo(0.04, 9);
  });

  it("OR may route around a stale branch for ranking (asymmetry vs evaluator)", () => {
    const staleLeaf = leaf(
      { kind: "price", market: marketB, source: "ask", comparator: "lte", threshold: 0.5 },
      "stale",
    );
    const fresh = priceLeaf(0.38, {}, "fresh");
    // TB has no view at all → that leaf is stale; the OR still ranks by TA.
    const p = strategyProximity(strat(group("or", [staleLeaf, fresh])), views(), NOW);
    expect(p.bindingNodeId).toBe("fresh");
    expect(p.rank).toBeCloseTo(0.02 / PROXIMITY.defaultTypicalMove, 9);
    expect(p.leaves.find((l) => l.nodeId === "stale")?.stale).toBe(true);
  });

  it("stale binding path sorts dead last", () => {
    const p = strategyProximity(strat(priceLeaf(0.5, { market: marketB })), views(), NOW);
    expect(p.rank).toBe(PROXIMITY.staleRank);
    expect(p.bindingDistance).toBeNull();
  });
});

describe("strategyProximity: gates and NOT", () => {
  const gateCases: { name: string; condition: ConditionV2; label: string }[] = [
    {
      name: "cumulative_notional",
      condition: {
        kind: "cumulative_notional",
        market: marketA,
        source: "ask",
        priceBound: 0.42,
        minNotional: 10_000,
      },
      label: "liquidity",
    },
    {
      name: "visible_levels",
      condition: {
        kind: "visible_levels",
        market: marketA,
        source: "ask",
        priceBound: 0.42,
        minLevels: 3,
      },
      label: "depth",
    },
    {
      name: "time_window",
      condition: { kind: "time_window", startMs: NOW + 60_000, endMs: null },
      label: "time",
    },
    {
      name: "spread",
      condition: { kind: "spread", market: marketA, comparator: "lte", threshold: 0.001 },
      label: "spread",
    },
  ];

  for (const { name, condition, label } of gateCases) {
    it(`unsatisfied ${name} blocks with label "${label}" and no fake cents`, () => {
      const p = strategyProximity(strat(leaf(condition)), views(), NOW);
      expect(p.rank).toBe(PROXIMITY.blockedRank);
      expect(p.bindingDistance).toBeNull();
      expect(p.blockedBy).toEqual([label]);
    });
  }

  it("a satisfied gate contributes distance 0", () => {
    const gate: ConditionV2 = {
      kind: "cumulative_notional",
      market: marketA,
      source: "ask",
      priceBound: 0.42,
      minNotional: 100,
    };
    const p = strategyProximity(
      strat(group("and", [leaf(gate), priceLeaf(0.34, {}, "px")])),
      views(),
      NOW,
    );
    expect(p.bindingNodeId).toBe("px");
    expect(p.blockedBy).toEqual([]);
  });

  it("an AND reports every blocking gate, not just the binding one", () => {
    const liq: ConditionV2 = {
      kind: "cumulative_notional",
      market: marketA,
      source: "ask",
      priceBound: 0.42,
      minNotional: 10_000,
    };
    const time: ConditionV2 = { kind: "time_window", startMs: NOW + 60_000, endMs: null };
    const p = strategyProximity(
      strat(group("and", [leaf(liq), leaf(time), priceLeaf(0.34)])),
      views(),
      NOW,
    );
    expect(p.rank).toBe(PROXIMITY.blockedRank);
    expect([...p.blockedBy].sort()).toEqual(["liquidity", "time"]);
  });

  it("NOT is a boolean gate: clear when satisfied, blocking otherwise", () => {
    const inner = priceLeaf(0.34); // unsatisfied → NOT satisfied
    const clear = strategyProximity(strat(group("not", [inner])), views(), NOW);
    expect(clear.rank).toBe(0);

    const innerTrue = priceLeaf(0.45); // satisfied → NOT blocks
    const blocked = strategyProximity(strat(group("not", [innerTrue])), views(), NOW);
    expect(blocked.rank).toBe(PROXIMITY.blockedRank);
    expect(blocked.blockedBy).toEqual(["condition"]);
  });
});

describe("strategyProximity: trailing and price_move", () => {
  it("trailing without a watermark blocks as arming", () => {
    const expr = leaf({
      kind: "trailing",
      market: marketA,
      mode: "stop",
      source: "bid",
      offset: 0.05,
    });
    const p = strategyProximity(strat(expr), views(0.6), NOW);
    expect(p.rank).toBe(PROXIMITY.blockedRank);
    expect(p.blockedBy).toEqual(["arming"]);
  });

  it("armed trailing stop measures bid − (peak − offset)", () => {
    const expr = leaf(
      { kind: "trailing", market: marketA, mode: "stop", source: "bid", offset: 0.05 },
      "trail",
    );
    const p = strategyProximity(strat(expr), views(0.58), NOW, {
      watermarks: { trail: { value: 0.6, armedAtMs: NOW - 1_000, updatedAtMs: NOW - 1_000 } },
    });
    // Trigger level 0.55; bid 0.58 → 0.03 away.
    expect(p.bindingDistance).toBeCloseTo(0.03, 9);
  });

  it("price_move measures the remaining delta (either = closest direction)", () => {
    const history: PriceSample[] = [
      { t: NOW - 600_000, p: 0.42 },
      { t: NOW - 300_000, p: 0.41 },
      { t: NOW - 60_000, p: 0.4 },
    ];
    const expr = leaf({
      kind: "price_move",
      market: marketA,
      direction: "either",
      deltaThreshold: 0.05,
      windowMs: 500_000,
    });
    const p = strategyProximity(
      strat(expr),
      { TA: viewAt(marketA, 0.38, 0.4, { priceHistory: history }) },
      NOW,
    );
    // Window covers drop 0.42→0.40 = 0.02; remaining 0.03.
    expect(p.bindingDistance).toBeCloseTo(0.03, 9);
  });

  it("price_move without window coverage is stale, never a fake distance", () => {
    const expr = leaf({
      kind: "price_move",
      market: marketA,
      direction: "drop",
      deltaThreshold: 0.05,
      windowMs: 500_000,
    });
    const p = strategyProximity(strat(expr), views(), NOW);
    expect(p.rank).toBe(PROXIMITY.staleRank);
  });
});

describe("strategyProximity: dwell rank", () => {
  const def = strat(priceLeaf(0.45), { holdsForMs: 600_000 });

  it("more-complete hold windows rank first, and any dwell beats any distance", () => {
    const at80 = strategyProximity(def, views(), NOW, { trueSinceMs: NOW - 480_000 });
    const at20 = strategyProximity(def, views(), NOW, { trueSinceMs: NOW - 120_000 });
    const waiting = strategyProximity(strat(priceLeaf(0.399)), views(), NOW); // 0.001 away
    expect(at80.rank).toBeCloseTo(-1.8, 9);
    expect(at20.rank).toBeCloseTo(-1.2, 9);
    expect(at80.rank).toBeLessThan(at20.rank);
    expect(at20.rank).toBeLessThan(waiting.rank);
    expect(at80.dwellFraction).toBeCloseTo(0.8, 9);
  });

  it("clamps dwell to [0, 1]", () => {
    const over = strategyProximity(def, views(), NOW, { trueSinceMs: NOW - 900_000 });
    expect(over.rank).toBe(-2);
    expect(over.dwellFraction).toBe(1);
    const future = strategyProximity(def, views(), NOW, { trueSinceMs: NOW + 5_000 });
    expect(future.dwellFraction).toBe(0);
  });

  it("holdsForMs 0 with a running window counts as complete", () => {
    const p = strategyProximity(strat(priceLeaf(0.45)), views(), NOW, {
      trueSinceMs: NOW - 1,
    });
    expect(p.rank).toBe(-2);
  });
});

describe("strategyProximity: drift", () => {
  const def = strat(priceLeaf(0.34)); // lte → wants the ask DOWN

  it("labels approaching / retreating / flat around the eps", () => {
    const down = strategyProximity(def, views(), NOW, { driftByToken: { TA: -0.02 } });
    const up = strategyProximity(def, views(), NOW, { driftByToken: { TA: 0.02 } });
    const flat = strategyProximity(def, views(), NOW, { driftByToken: { TA: 0.001 } });
    const none = strategyProximity(def, views(), NOW);
    expect(down.drift).toBe("approaching");
    expect(up.drift).toBe("retreating");
    expect(flat.drift).toBe("flat");
    expect(none.drift).toBeNull();
  });

  it("gte flips the desired direction", () => {
    const sell = strat(priceLeaf(0.6, { source: "bid", comparator: "gte" }));
    const p = strategyProximity(sell, views(0.55), NOW, { driftByToken: { TA: 0.02 } });
    expect(p.drift).toBe("approaching");
  });
});

describe("history helpers", () => {
  it("typicalMovement is the mean absolute step (null under 3 points)", () => {
    expect(typicalMovement([])).toBeNull();
    expect(
      typicalMovement([
        { t: 1, p: 0.4 },
        { t: 2, p: 0.42 },
      ]),
    ).toBeNull();
    expect(
      typicalMovement([
        { t: 1, p: 0.4 },
        { t: 2, p: 0.42 },
        { t: 3, p: 0.39 },
      ]),
    ).toBeCloseTo((0.02 + 0.03) / 2, 9);
  });

  it("recentDrift reads last − the newest sample at/before the cutoff", () => {
    const history: PriceSample[] = [
      { t: 0, p: 0.5 },
      { t: 40_000, p: 0.45 },
      { t: 100_000, p: 0.4 },
    ];
    expect(recentDrift(history, 60_000)).toBeCloseTo(-0.05, 9); // vs t=40k sample
    expect(recentDrift(history, 90_000)).toBeCloseTo(-0.1, 9); // walks back to t=0
    expect(recentDrift(history, 150_000)).toBeNull(); // history too young
    // Sparse history stretches the effective lookback to the nearest sample.
    expect(recentDrift(history, 10_000)).toBeCloseTo(-0.05, 9);
    expect(recentDrift([{ t: 0, p: 0.5 }], 10_000)).toBeNull();
  });
});
