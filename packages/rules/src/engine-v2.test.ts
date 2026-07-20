import { describe, it, expect } from "vitest";
import { evaluateExpression } from "./evaluate-v2.js";
import { normalizeDefinition, referencedTokenIds } from "./compat.js";
import { hashDefinition } from "./evidence.js";
import { runReplay, runReplayV2 } from "./replay.js";
import { transitionV2 } from "./state-machine-v2.js";
import { validateStrategyDefinition } from "./validate-v2.js";
import type { EvalEvent, MarketDataView, RuleDefinition } from "./types.js";
import type {
  EvalEventV2,
  ExprNode,
  MarketRef,
  StrategyDefinition,
  ViewsByToken,
} from "./types-v2.js";

const HOLD = 600_000; // 10 minutes

const marketA: MarketRef = { conditionId: "CA", tokenId: "TA", outcome: "YES" };
const marketB: MarketRef = { conditionId: "CB", tokenId: "TB", outcome: "YES" };

const viewFor = (
  m: MarketRef,
  sourceTimeMs: number,
  over: Partial<MarketDataView> = {},
): MarketDataView => ({
  tokenId: m.tokenId,
  conditionId: m.conditionId,
  asks: [
    { price: 0.48, size: 1000 },
    { price: 0.49, size: 1000 },
    { price: 0.5, size: 1000 },
  ],
  bids: [{ price: 0.47, size: 500 }],
  marketStatus: "open",
  sourceTimeMs,
  receivedAtMs: sourceTimeMs,
  ...over,
});

const priceLeaf = (id: string, m: MarketRef, threshold = 0.5): ExprNode => ({
  type: "condition",
  id,
  condition: { kind: "price", market: m, source: "ask", comparator: "lte", threshold },
});

const strat = (expr: ExprNode, over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  version: 2,
  name: "test",
  templateId: null,
  expr,
  holdsForMs: HOLD,
  maxDataAgeMs: 2_000,
  action: {
    kind: "order",
    market: marketA,
    side: "BUY",
    price: 0.49,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const bookV2 = (views: ViewsByToken, nowMs: number): EvalEventV2 => ({
  type: "book",
  views,
  nowMs,
});

const freshBoth = (nowMs: number): ViewsByToken => ({
  TA: viewFor(marketA, nowMs),
  TB: viewFor(marketB, nowMs),
});

// ── Expression evaluation ────────────────────────────────────────────────────

describe("evaluateExpression — logic composition", () => {
  const failView = (m: MarketRef, nowMs: number) =>
    viewFor(m, nowMs, { asks: [{ price: 0.9, size: 100 }] });

  it("AND requires every child", () => {
    const def = strat({
      type: "group",
      id: "root",
      op: "and",
      children: [priceLeaf("a", marketA), priceLeaf("b", marketB)],
    });
    expect(evaluateExpression(def, freshBoth(0), 0).satisfied).toBe(true);
    expect(
      evaluateExpression(def, { TA: viewFor(marketA, 0), TB: failView(marketB, 0) }, 0).satisfied,
    ).toBe(false);
  });

  it("OR needs one child; NOT inverts a single child", () => {
    const or = strat({
      type: "group",
      id: "root",
      op: "or",
      children: [priceLeaf("a", marketA, 0.1), priceLeaf("b", marketB)],
    });
    expect(evaluateExpression(or, freshBoth(0), 0).satisfied).toBe(true);

    const not = strat({
      type: "group",
      id: "root",
      op: "not",
      children: [priceLeaf("a", marketA, 0.1)], // best ask 0.48 > 0.1 → leaf false → NOT true
    });
    expect(evaluateExpression(not, { TA: viewFor(marketA, 0) }, 0).satisfied).toBe(true);
  });

  it("returns a result tree mirroring the expression with per-leaf actuals", () => {
    const def = strat({
      type: "group",
      id: "root",
      op: "and",
      children: [priceLeaf("a", marketA), priceLeaf("b", marketB)],
    });
    const e = evaluateExpression(def, freshBoth(0), 0);
    expect(e.root.type).toBe("group");
    if (e.root.type !== "group") return;
    expect(e.root.children).toHaveLength(2);
    const leaf = e.root.children[0]!;
    expect(leaf.type).toBe("condition");
    if (leaf.type !== "condition") return;
    expect(leaf.id).toBe("a");
    expect(leaf.result.actual).toBe(0.48);
    expect(leaf.result.tokenId).toBe("TA");
  });

  it("evaluates spread and time_window conditions", () => {
    const def = strat({
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "s",
          condition: { kind: "spread", market: marketA, comparator: "lte", threshold: 0.02 },
        },
        {
          type: "condition",
          id: "t",
          condition: { kind: "time_window", startMs: 0, endMs: 10_000 },
        },
      ],
    });
    // spread = 0.48 - 0.47 = 0.01 ≤ 0.02; now=5000 within [0, 10000]
    const inWindow = evaluateExpression(def, { TA: viewFor(marketA, 5_000) }, 5_000);
    expect(inWindow.satisfied).toBe(true);
    // outside the time window
    const outside = evaluateExpression(def, { TA: viewFor(marketA, 20_000) }, 20_000);
    expect(outside.satisfied).toBe(false);
    expect(outside.reasonCodes).toContain("TIME_WINDOW_FAIL");
  });
});

describe("evaluateExpression — fail-closed staleness matrix", () => {
  const orDef = strat({
    type: "group",
    id: "root",
    op: "or",
    children: [priceLeaf("a", marketA), priceLeaf("b", marketB)],
  });

  it("any referenced market stale ⇒ unsatisfied, even inside a satisfied OR", () => {
    const views: ViewsByToken = {
      TA: viewFor(marketA, 10_000), // fresh + true
      TB: viewFor(marketB, 0), // 10s old > 2s maxDataAge
    };
    const e = evaluateExpression(orDef, views, 10_000);
    expect(e.satisfied).toBe(false);
    expect(e.staleTokenIds).toEqual(["TB"]);
    expect(e.reasonCodes).toContain("DATA_STALE");
  });

  it("any referenced market missing ⇒ unsatisfied", () => {
    const e = evaluateExpression(orDef, { TA: viewFor(marketA, 0) }, 0);
    expect(e.satisfied).toBe(false);
    expect(e.staleTokenIds).toEqual(["TB"]);
  });

  it("staleness overrides NOT inversion (stale can never satisfy)", () => {
    const notDef = strat({
      type: "group",
      id: "root",
      op: "not",
      children: [priceLeaf("a", marketA)],
    });
    // Leaf is stale → leaf unsatisfied → NOT(leaf) = true at tree level,
    // but the root verdict must stay fail-closed false.
    const e = evaluateExpression(notDef, { TA: viewFor(marketA, 0) }, 60_000);
    expect(e.root.satisfied).toBe(true);
    expect(e.satisfied).toBe(false);
  });

  it("time_window-only strategies never go stale", () => {
    const def = strat({
      type: "condition",
      id: "t",
      condition: { kind: "time_window", startMs: null, endMs: null },
    });
    const e = evaluateExpression(def, {}, 123);
    expect(e.satisfied).toBe(true);
    expect(e.staleTokenIds).toEqual([]);
  });
});

// ── Cross-market accumulation ────────────────────────────────────────────────

describe("transitionV2 — cross-market window", () => {
  const def = strat({
    type: "group",
    id: "root",
    op: "and",
    children: [priceLeaf("a", marketA), priceLeaf("b", marketB)],
  });

  it("triggers after both markets hold continuously for the window", () => {
    const r = runReplayV2(def, [
      bookV2(freshBoth(0), 0),
      bookV2(freshBoth(300_000), 300_000),
      bookV2(freshBoth(HOLD), HOLD),
    ]);
    expect(r.finalState.status).toBe("TRIGGERED_AWAITING_USER");
    expect(r.triggers).toHaveLength(1);
    const t = r.triggers[0]!;
    expect(t.windowStartMs).toBe(0);
    expect(t.triggeredAtMs).toBe(HOLD);
    expect(t.triggerNumber).toBe(1);
    expect(t.markets.map((m) => m.tokenId).sort()).toEqual(["TA", "TB"]);
    // Flat v1-compatible fields point at the order's market (TA).
    expect(t.tokenId).toBe("TA");
    expect(t.bestAsk).toBe(0.48);
  });

  it("one market going stale mid-window pauses, then restarts past the grace", () => {
    const r = runReplayV2(def, [
      bookV2(freshBoth(0), 0),
      // TB's view stops updating: at t=300s it is 300s old → stale PAUSE.
      bookV2({ TA: viewFor(marketA, 300_000), TB: viewFor(marketB, 0) }, 300_000),
      // Fresh again at t=HOLD, but the 300s dark gap exceeded the 4s grace —
      // continuity can't be attested, so the window restarts from here.
      bookV2(freshBoth(HOLD), HOLD),
    ]);
    expect(r.triggers).toHaveLength(0);
    expect(r.finalState.status).toBe("ACTIVE_ACCUMULATING");
    expect(r.finalState.trueSinceMs).toBe(HOLD);
    expect(r.transitions.map((x) => `${x.from}->${x.to}:${x.reason}`)).toEqual([
      "ACTIVE_WAITING->ACTIVE_ACCUMULATING:WINDOW_STARTED",
      "ACTIVE_ACCUMULATING->ACTIVE_ACCUMULATING:STALE_PAUSED",
      "ACTIVE_ACCUMULATING->ACTIVE_ACCUMULATING:DATA_STALE",
    ]);
  });

  it("resumes within the grace, excising the stale gap from the hold window", () => {
    // maxDataAgeMs 2s → default grace 4s. Pause at 300s, fresh again at 303s
    // (gap 3s ≤ grace): trueSince shifts 0 → 3s, so the trigger lands at 603s.
    const single = strat(priceLeaf("a", marketA));
    const va = (t: number): ViewsByToken => ({ TA: viewFor(marketA, t) });
    const r = runReplayV2(single, [
      bookV2(va(0), 0),
      bookV2({ TA: viewFor(marketA, 297_000) }, 300_000),
      bookV2(va(303_000), 303_000),
      bookV2(va(603_000), 603_000),
    ]);
    expect(r.transitions.map((x) => `${x.from}->${x.to}:${x.reason}`)).toEqual([
      "ACTIVE_WAITING->ACTIVE_ACCUMULATING:WINDOW_STARTED",
      "ACTIVE_ACCUMULATING->ACTIVE_ACCUMULATING:STALE_PAUSED",
      "ACTIVE_ACCUMULATING->ACTIVE_ACCUMULATING:STALE_RESUMED",
      "ACTIVE_ACCUMULATING->TRIGGERED_AWAITING_USER:WINDOW_COMPLETE",
    ]);
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]!.windowStartMs).toBe(3_000);
    expect(r.triggers[0]!.triggeredAtMs).toBe(603_000);
  });

  it("fresh-but-unsatisfied data during a pause resets immediately", () => {
    const single = strat(priceLeaf("a", marketA));
    const va = (t: number): ViewsByToken => ({ TA: viewFor(marketA, t) });
    const r = runReplayV2(single, [
      bookV2(va(0), 0),
      bookV2({ TA: viewFor(marketA, 297_000) }, 300_000), // stale → paused
      bookV2({ TA: viewFor(marketA, 302_000, { asks: [{ price: 0.9, size: 100 }] }) }, 302_000),
    ]);
    expect(r.finalState.status).toBe("ACTIVE_WAITING");
    expect(r.transitions.at(-1)?.reason).toBe("PRICE_FAIL");
    expect(r.finalState.staleSinceMs).toBeNull();
  });

  it("staleGraceMs 0 keeps the strict legacy reset", () => {
    const strict = strat(priceLeaf("a", marketA), { staleGraceMs: 0 });
    const va = (t: number): ViewsByToken => ({ TA: viewFor(marketA, t) });
    const r = runReplayV2(strict, [
      bookV2(va(0), 0),
      bookV2({ TA: viewFor(marketA, 297_000) }, 300_000),
    ]);
    expect(r.finalState.status).toBe("ACTIVE_WAITING");
    expect(r.transitions.at(-1)?.reason).toBe("DATA_STALE");
  });

  it("reconnect pauses the window; a dark grace expiry then resets", () => {
    const single = strat(priceLeaf("a", marketA));
    const va = (t: number): ViewsByToken => ({ TA: viewFor(marketA, t) });
    const r = runReplayV2(single, [
      bookV2(va(0), 0),
      { type: "reconnect", nowMs: 100_000 },
      { type: "tick", views: null, nowMs: 105_000 },
    ]);
    expect(r.transitions.map((x) => `${x.from}->${x.to}:${x.reason}`)).toEqual([
      "ACTIVE_WAITING->ACTIVE_ACCUMULATING:WINDOW_STARTED",
      "ACTIVE_ACCUMULATING->ACTIVE_ACCUMULATING:STALE_PAUSED",
      "ACTIVE_ACCUMULATING->ACTIVE_WAITING:DATA_STALE",
    ]);
  });

  it("any referenced market closing invalidates the strategy", () => {
    const r = runReplayV2(def, [
      bookV2(freshBoth(0), 0),
      bookV2(
        { TA: viewFor(marketA, 1_000), TB: viewFor(marketB, 1_000, { marketStatus: "closed" }) },
        1_000,
      ),
    ]);
    expect(r.finalState.status).toBe("INVALIDATED");
    expect(r.transitions.at(-1)?.reason).toBe("MARKET_CLOSED");
  });
});

// ── Repeat recurrence + cooldown ─────────────────────────────────────────────

describe("transitionV2 — repeat with cooldown", () => {
  const COOLDOWN = 120_000;
  const alertRepeat = strat(priceLeaf("a", marketA), {
    holdsForMs: 60_000,
    action: { kind: "alert" },
    recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: COOLDOWN },
  });
  const va = (nowMs: number): ViewsByToken => ({ TA: viewFor(marketA, nowMs) });

  it("re-arms with a cooldown between triggers and completes after maxRepeats", () => {
    const events: EvalEventV2[] = [];
    // Feed a satisfied fresh book every 30s for a long horizon.
    for (let t = 0; t <= 1_500_000; t += 30_000) events.push(bookV2(va(t), t));
    const r = runReplayV2(alertRepeat, events);

    expect(r.triggers).toHaveLength(3);
    expect(r.triggers.map((t) => t.triggerNumber)).toEqual([1, 2, 3]);
    expect(r.finalState.status).toBe("COMPLETED");

    // Trigger 1 at 60s (window complete). Cooldown until 180s, accumulation
    // restarts at the next event ≥180s, so trigger 2 = 180s + 60s = 240s.
    expect(r.triggers[0]!.triggeredAtMs).toBe(60_000);
    expect(r.triggers[1]!.triggeredAtMs).toBe(240_000);
    expect(r.triggers[2]!.triggeredAtMs).toBe(420_000);
  });

  it("does not accumulate during the cooldown period", () => {
    const first = runReplayV2(alertRepeat, [bookV2(va(0), 0), bookV2(va(60_000), 60_000)]);
    expect(first.triggers).toHaveLength(1);
    const rt = first.finalState;
    expect(rt.status).toBe("ACTIVE_WAITING");
    expect(rt.cooldownUntilMs).toBe(60_000 + COOLDOWN);

    // A satisfied book inside the cooldown must not start a window.
    const during = transitionV2(
      alertRepeat,
      hashDefinition(alertRepeat),
      rt,
      bookV2(va(100_000), 100_000),
    );
    expect(during.runtime.status).toBe("ACTIVE_WAITING");
    expect(during.runtime.trueSinceMs).toBeNull();
  });

  it("auto-order strategies end their final trigger awaiting execution", () => {
    const autoRepeat = strat(priceLeaf("a", marketA), {
      holdsForMs: 60_000,
      action: {
        kind: "order",
        market: marketA,
        side: "BUY",
        price: 0.49,
        size: 10,
        orderType: "GTC",
        execution: "auto",
      },
      limits: { maxNotionalPerOrder: 10, maxTotalNotional: 30, maxDailyNotional: 30 },
      recurrence: { kind: "repeat", maxRepeats: 2, cooldownMs: COOLDOWN },
    });
    const events: EvalEventV2[] = [];
    for (let t = 0; t <= 600_000; t += 30_000) events.push(bookV2(va(t), t));
    const r = runReplayV2(autoRepeat, events);
    expect(r.triggers).toHaveLength(2);
    // Final trigger keeps the v1-compatible handoff to the executor.
    expect(r.finalState.status).toBe("TRIGGERED_AWAITING_USER");
  });
});

// ── v1 parity (migration-safety proof) ───────────────────────────────────────

describe("v1 → v2 compat parity", () => {
  const v1def = (over: Partial<RuleDefinition> = {}): RuleDefinition => ({
    version: 1,
    tokenId: "TA",
    conditionId: "CA",
    outcomeSide: "BUY",
    predicates: [
      { kind: "price", source: "ask", comparator: "lte", threshold: 0.5 },
      { kind: "cumulative_notional", source: "ask", priceBound: 0.5, minNotional: 1000 },
      { kind: "visible_levels", source: "ask", priceBound: 0.5, minLevels: 3 },
    ],
    continuousWindowMs: HOLD,
    maxDataAgeMs: 2_000,
    action: { kind: "prepare_order", side: "BUY", price: 0.49, size: 100, orderType: "GTC" },
    recurrence: "once",
    expiresAtMs: null,
    ...over,
  });

  /** Mirror a v1 event sequence into the v2 single-token shape. */
  const mirror = (events: readonly EvalEvent[]): EvalEventV2[] =>
    events.map((e) => {
      switch (e.type) {
        case "book":
          return { type: "book", views: { [e.view.tokenId]: e.view }, nowMs: e.nowMs };
        case "tick":
          return {
            type: "tick",
            views: e.latestView ? { [e.latestView.tokenId]: e.latestView } : null,
            nowMs: e.nowMs,
          };
        case "market_status":
          return { type: "market_status", tokenId: "TA", status: e.status, nowMs: e.nowMs };
        default:
          return e;
      }
    });

  const scenarios: { name: string; events: EvalEvent[] }[] = (() => {
    const v = (t: number, over: Partial<MarketDataView> = {}) => viewFor(marketA, t, over);
    const b = (t: number, over: Partial<MarketDataView> = {}): EvalEvent => ({
      type: "book",
      view: v(t, over),
      nowMs: t,
    });
    return [
      {
        name: "clean trigger",
        events: [b(0), b(200_000), b(400_000), b(HOLD)],
      },
      {
        name: "stale reset then trigger",
        events: [
          b(0),
          { type: "book", view: v(100_000), nowMs: 300_000 }, // 200s-old data
          b(400_000),
          b(400_000 + HOLD),
        ],
      },
      {
        name: "predicate flap resets the window",
        events: [
          b(0),
          b(100_000, { asks: [{ price: 0.9, size: 100 }] }),
          b(200_000),
          b(200_000 + HOLD),
        ],
      },
      {
        name: "reconnect breaks the window",
        events: [b(0), { type: "reconnect", nowMs: 100_000 }, b(200_000), b(200_000 + HOLD)],
      },
      {
        name: "pause and resume",
        events: [
          b(0),
          { type: "pause", nowMs: 50_000 },
          b(60_000),
          { type: "resume", nowMs: 100_000 },
          b(150_000),
          b(150_000 + HOLD),
        ],
      },
      {
        name: "market close invalidates",
        events: [b(0), b(100_000, { marketStatus: "closed" })],
      },
      {
        name: "expiry on tick without data",
        events: [b(0), { type: "tick", latestView: null, nowMs: 400_000 }],
      },
      {
        name: "never satisfied",
        events: [b(0, { asks: [{ price: 0.9, size: 10 }] }), b(HOLD, { asks: [] })],
      },
    ];
  })();

  for (const { name, events } of scenarios) {
    it(`parity: ${name}`, () => {
      const d1 = v1def(name === "expiry on tick without data" ? { expiresAtMs: 300_000 } : {});
      const d2 = normalizeDefinition(d1);
      const r1 = runReplay(d1, events);
      const r2 = runReplayV2(d2, mirror(events), { definitionHash: hashDefinition(d1) });

      expect(r2.finalState.status).toBe(r1.finalState.status);
      expect(r2.finalState.trueSinceMs).toBe(r1.finalState.trueSinceMs);
      expect(r2.transitions.map((t) => `${t.from}->${t.to}:${t.reason}@${t.atMs}`)).toEqual(
        r1.transitions.map((t) => `${t.from}->${t.to}:${t.reason}@${t.atMs}`),
      );
      expect(r2.triggers).toHaveLength(r1.triggers.length);
      r1.triggers.forEach((t1, i) => {
        const t2 = r2.triggers[i]!;
        expect(t2.windowStartMs).toBe(t1.windowStartMs);
        expect(t2.windowEndMs).toBe(t1.windowEndMs);
        expect(t2.triggeredAtMs).toBe(t1.triggeredAtMs);
        expect(t2.tokenId).toBe(t1.tokenId);
        expect(t2.bestAsk).toBe(t1.bestAsk);
        expect(t2.bestBid).toBe(t1.bestBid);
        // Evidence stays tied to the ORIGINAL v1 definition hash.
        expect(t2.ruleDefinitionHash).toBe(t1.ruleDefinitionHash);
      });
    });
  }

  it("normalization is deterministic and preserves the referenced token set", () => {
    const d = v1def();
    expect(normalizeDefinition(d)).toEqual(normalizeDefinition(d));
    expect(referencedTokenIds(normalizeDefinition(d))).toEqual(["TA"]);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("validateStrategyDefinition", () => {
  const codes = (d: StrategyDefinition) => validateStrategyDefinition(d).map((i) => i.code);

  it("accepts a well-formed strategy", () => {
    expect(codes(strat(priceLeaf("a", marketA)))).toEqual([]);
  });

  it("requires limits for auto execution and consistency between caps", () => {
    const auto = strat(priceLeaf("a", marketA), {
      action: {
        kind: "order",
        market: marketA,
        side: "BUY",
        price: 0.49,
        size: 100,
        orderType: "GTC",
        execution: "auto",
      },
    });
    expect(codes(auto)).toContain("AUTO_REQUIRES_LIMITS");

    const bad = strat(priceLeaf("a", marketA), {
      action: { ...auto.action },
      limits: { maxNotionalPerOrder: 10, maxTotalNotional: 5, maxDailyNotional: 8 },
    });
    expect(codes(bad)).toContain("LIMITS_INCONSISTENT");
    expect(codes(bad)).toContain("ORDER_EXCEEDS_PER_ORDER_CAP");
  });

  it("rejects malformed NOT groups, empty groups and deep nesting", () => {
    const notBad = strat({
      type: "group",
      id: "n",
      op: "not",
      children: [priceLeaf("a", marketA), priceLeaf("b", marketB)],
    });
    expect(codes(notBad)).toContain("NOT_GROUP_ARITY");

    const deep = strat({
      type: "group",
      id: "g1",
      op: "and",
      children: [
        {
          type: "group",
          id: "g2",
          op: "or",
          children: [{ type: "group", id: "g3", op: "and", children: [priceLeaf("a", marketA)] }],
        },
      ],
    });
    expect(codes(deep)).toContain("EXPR_TOO_DEEP");
  });

  it("restricts repeat to alert/auto actions", () => {
    const prepared = strat(priceLeaf("a", marketA), {
      recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 1_000 },
    });
    expect(codes(prepared)).toContain("REPEAT_REQUIRES_ALERT_OR_AUTO");
  });
});
