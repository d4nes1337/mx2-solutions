/**
 * Trailing (watermark) condition: evaluator semantics, state-machine
 * persistence (D-025: watermarks survive resets/reconnects/restarts, freeze on
 * stale data, clear per repetition), validation bounds and backtest parity.
 */
import { describe, it, expect } from "vitest";
import { evaluateExpression } from "./evaluate-v2.js";
import { initialRuntimeV2, transitionV2 } from "./state-machine-v2.js";
import { validateStrategyDefinition } from "./validate-v2.js";
import { simulateTriggers } from "./simulate.js";
import type { MarketDataView } from "./types.js";
import type {
  EvalEventV2,
  ExprNode,
  MarketRef,
  StrategyDefinition,
  StrategyRuntime,
  ViewsByToken,
  WatermarksByNode,
} from "./types-v2.js";

const market: MarketRef = { conditionId: "CA", tokenId: "TA", outcome: "YES" };

const viewAt = (nowMs: number, bid: number, ask = bid + 0.02): MarketDataView => ({
  tokenId: market.tokenId,
  conditionId: market.conditionId,
  asks: [{ price: ask, size: 1000 }],
  bids: [{ price: bid, size: 1000 }],
  marketStatus: "open",
  sourceTimeMs: nowMs,
  receivedAtMs: nowMs,
});

const stopLeaf = (offset = 0.05): ExprNode => ({
  type: "condition",
  id: "c1",
  condition: { kind: "trailing", market, mode: "stop", source: "bid", offset },
});

const entryLeaf = (offset = 0.05): ExprNode => ({
  type: "condition",
  id: "c1",
  condition: { kind: "trailing", market, mode: "entry", source: "ask", offset },
});

const wrap = (leaf: ExprNode): ExprNode => ({
  type: "group",
  id: "root",
  op: "and",
  children: [leaf],
});

const strat = (expr: ExprNode, over: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
  version: 2,
  name: "trail-test",
  templateId: null,
  expr,
  holdsForMs: 0,
  maxDataAgeMs: 2_000,
  action: { kind: "alert" },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const views = (nowMs: number, bid: number, ask?: number): ViewsByToken => ({
  TA: viewAt(nowMs, bid, ask),
});

const book = (nowMs: number, bid: number, ask?: number): EvalEventV2 => ({
  type: "book",
  views: views(nowMs, bid, ask),
  nowMs,
});

const leafResult = (evaluation: ReturnType<typeof evaluateExpression>) => {
  const root = evaluation.root;
  if (root.type !== "group") throw new Error("expected group root");
  const child = root.children[0]!;
  if (child.type !== "condition") throw new Error("expected condition child");
  return child.result;
};

describe("evaluateExpression: trailing", () => {
  const def = strat(wrap(stopLeaf(0.05)));

  it("arms on the first fresh observation and never fires on it", () => {
    const e = evaluateExpression(def, views(1_000, 0.5), 1_000, {});
    expect(e.satisfied).toBe(false);
    const r = leafResult(e);
    expect(r.reason).toBe("TRAILING_ARMING");
    expect(r.watermark).toBe(0.5);
    expect(e.watermarks["c1"]).toMatchObject({ value: 0.5, armedAtMs: 1_000 });
  });

  it("stop: ratchets the peak and fires exactly at peak − offset", () => {
    let wm: WatermarksByNode = {};
    // Arm at 0.50, rise to 0.60 (peak), sag to 0.56 — not yet 0.05 below peak.
    for (const [t, bid] of [
      [1_000, 0.5],
      [2_000, 0.6],
      [3_000, 0.56],
    ] as const) {
      const e = evaluateExpression(def, views(t, bid), t, wm);
      expect(e.satisfied).toBe(false);
      wm = e.watermarks;
    }
    expect(wm["c1"]!.value).toBe(0.6);

    // 0.55 = peak − offset exactly → fires; threshold reports the level.
    const e = evaluateExpression(def, views(4_000, 0.55), 4_000, wm);
    expect(e.satisfied).toBe(true);
    const r = leafResult(e);
    expect(r.reason).toBe("TRAILING_OK");
    expect(r.threshold).toBeCloseTo(0.55, 10);
    expect(r.actual).toBe(0.55);
    expect(r.watermark).toBe(0.6);
  });

  it("entry: ratchets the trough and fires at trough + offset", () => {
    const entryDef = strat(wrap(entryLeaf(0.05)));
    let wm: WatermarksByNode = {};
    // Ask falls 0.50 → 0.40 (trough), small bounce to 0.44 — not yet.
    for (const [t, ask] of [
      [1_000, 0.5],
      [2_000, 0.4],
      [3_000, 0.44],
    ] as const) {
      const e = evaluateExpression(entryDef, views(t, ask - 0.02, ask), t, wm);
      expect(e.satisfied).toBe(false);
      wm = e.watermarks;
    }
    expect(wm["c1"]!.value).toBe(0.4);

    const e = evaluateExpression(entryDef, views(4_000, 0.43, 0.45), 4_000, wm);
    expect(e.satisfied).toBe(true);
    expect(leafResult(e).threshold).toBeCloseTo(0.45, 10);
  });

  it("freezes the watermark on stale or missing data (fail-closed)", () => {
    const armed = evaluateExpression(def, views(1_000, 0.6), 1_000, {});
    // Stale view (sourceTime far behind now): unsatisfied + stale, wm carried.
    const staleViews: ViewsByToken = { TA: viewAt(1_000, 0.2) };
    const e1 = evaluateExpression(def, staleViews, 10_000, armed.watermarks);
    expect(e1.satisfied).toBe(false);
    expect(leafResult(e1).stale).toBe(true);
    expect(e1.watermarks["c1"]!.value).toBe(0.6); // NOT ratcheted down, NOT dropped

    // Missing view entirely: same freeze.
    const e2 = evaluateExpression(def, {}, 11_000, armed.watermarks);
    expect(e2.satisfied).toBe(false);
    expect(e2.watermarks["c1"]!.value).toBe(0.6);
  });

  it("NOT(trailing) cannot fire on stale data (global override)", () => {
    const notDef = strat({
      type: "group",
      id: "root",
      op: "and",
      children: [{ type: "group", id: "n1", op: "not", children: [stopLeaf(0.05)] }],
    });
    const armed = evaluateExpression(notDef, views(1_000, 0.6), 1_000, {});
    // Arming tick is fresh and the leaf is false → NOT legitimately holds
    // ("the price has NOT fallen 5¢ from its peak" is true).
    expect(armed.satisfied).toBe(true);
    const e = evaluateExpression(notDef, views(2_000, 0.6), 2_000, armed.watermarks);
    expect(e.satisfied).toBe(true); // armed, no drop → NOT holds on fresh data

    const eStale = evaluateExpression(notDef, {}, 10_000, e.watermarks);
    expect(eStale.satisfied).toBe(false); // stale overrides the NOT verdict
  });

  it("is pure: never mutates watermarksIn, deterministic output", () => {
    const wmIn: WatermarksByNode = { c1: { value: 0.6, armedAtMs: 1, updatedAtMs: 1 } };
    const frozen = JSON.stringify(wmIn);
    const a = evaluateExpression(def, views(2_000, 0.62), 2_000, wmIn);
    const b = evaluateExpression(def, views(2_000, 0.62), 2_000, wmIn);
    expect(JSON.stringify(wmIn)).toBe(frozen);
    expect(a).toEqual(b);
    expect(a.watermarks).not.toBe(wmIn);
    expect(a.watermarks["c1"]!.value).toBe(0.62);
  });

  it("round-trips through JSON (plain-object constraint)", () => {
    const e = evaluateExpression(def, views(1_000, 0.5), 1_000, {});
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    expect(JSON.parse(JSON.stringify(initialRuntimeV2()))).toEqual(initialRuntimeV2());
  });
});

describe("transitionV2: trailing watermark lifecycle", () => {
  const HASH = "hash-trail";

  const step = (
    def: StrategyDefinition,
    rt: StrategyRuntime,
    event: EvalEventV2,
  ): ReturnType<typeof transitionV2> => transitionV2(def, HASH, rt, event);

  it("persists the watermark through pause/resume and reconnect", () => {
    const def = strat(wrap(stopLeaf(0.05)));
    let rt = initialRuntimeV2();
    rt = step(def, rt, book(1_000, 0.6)).runtime; // arm at 0.6
    expect(rt.watermarks?.["c1"]?.value).toBe(0.6);

    rt = step(def, rt, { type: "pause", nowMs: 2_000 }).runtime;
    rt = step(def, rt, { type: "resume", nowMs: 3_000 }).runtime;
    rt = step(def, rt, { type: "reconnect", nowMs: 4_000 }).runtime;
    expect(rt.watermarks?.["c1"]?.value).toBe(0.6);

    // First fresh data after the gap: a 6¢ drop through the level fires.
    const res = step(def, rt, book(5_000, 0.54));
    expect(res.trigger).not.toBeNull();
    expect(res.trigger!.watermarks?.["c1"]?.value).toBe(0.6);
  });

  it("keeps the watermark through a DATA_STALE hold-window reset", () => {
    const def = strat(wrap(stopLeaf(0.05)), { holdsForMs: 600_000 });
    let rt = initialRuntimeV2();
    rt = step(def, rt, book(1_000, 0.6)).runtime; // arm
    rt = step(def, rt, book(2_000, 0.55)).runtime; // satisfied → accumulating
    expect(rt.status).toBe("ACTIVE_ACCUMULATING");

    // Stale tick breaks the window but not the watermark.
    const res = step(def, rt, { type: "tick", views: views(2_000, 0.55), nowMs: 60_000 });
    expect(res.runtime.status).toBe("ACTIVE_WAITING");
    expect(res.transition?.reason).toBe("DATA_STALE");
    expect(res.runtime.watermarks?.["c1"]?.value).toBe(0.6);
  });

  it("bounce above the trigger level resets the hold window, not the watermark", () => {
    const def = strat(wrap(stopLeaf(0.05)), { holdsForMs: 600_000 });
    let rt = initialRuntimeV2();
    rt = step(def, rt, book(1_000, 0.6)).runtime;
    rt = step(def, rt, book(2_000, 0.55)).runtime; // accumulating
    const res = step(def, rt, book(3_000, 0.58)); // bounce → reset
    expect(res.runtime.status).toBe("ACTIVE_WAITING");
    expect(res.transition?.reason).toBe("TRAILING_FAIL");
    expect(res.runtime.watermarks?.["c1"]?.value).toBe(0.6);
    expect(res.runtime.trueSinceMs).toBeNull();
  });

  it("repeat trigger clears trailing state; cooldown freezes; re-arms after", () => {
    const def = strat(wrap(stopLeaf(0.05)), {
      recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 10_000 },
    });
    let rt = initialRuntimeV2();
    rt = step(def, rt, book(1_000, 0.6)).runtime; // arm at 0.6
    const fire = step(def, rt, book(2_000, 0.54)); // drop 6¢ → trigger #1
    expect(fire.trigger?.triggerNumber).toBe(1);
    rt = fire.runtime;
    expect(rt.status).toBe("ACTIVE_WAITING");
    expect(rt.watermarks?.["c1"]).toBeUndefined(); // cleared for the next repetition

    // Inside cooldown: no re-arm (observation gated before evaluation).
    rt = step(def, rt, book(5_000, 0.7)).runtime;
    expect(rt.watermarks?.["c1"]).toBeUndefined();

    // After cooldown: re-arms at the CURRENT price, not the old peak.
    rt = step(def, rt, book(13_000, 0.5)).runtime;
    expect(rt.watermarks?.["c1"]?.value).toBe(0.5);
  });

  it("no-trailing strategies keep empty watermarks and identical behavior", () => {
    const def = strat(
      wrap({
        type: "condition",
        id: "p1",
        condition: { kind: "price", market, source: "ask", comparator: "lte", threshold: 0.5 },
      }),
    );
    const rt = initialRuntimeV2();
    const res = step(def, rt, book(1_000, 0.4, 0.42));
    expect(res.runtime.watermarks).toEqual({});
    expect(res.trigger).not.toBeNull(); // alert with holdsForMs 0 fires
  });
});

describe("validateStrategyDefinition: trailing", () => {
  it("bounds the offset to [0.01, 0.5]", () => {
    for (const [offset, ok] of [
      [0.009, false],
      [0.01, true],
      [0.5, true],
      [0.51, false],
    ] as const) {
      const codes = validateStrategyDefinition(strat(wrap(stopLeaf(offset)))).map((i) => i.code);
      expect(codes.includes("TRAILING_OFFSET_OUT_OF_RANGE")).toBe(!ok);
    }
  });

  it("refuses trailing conditions gating a quote_loop", () => {
    const def = strat(wrap(stopLeaf(0.05)), {
      action: {
        kind: "quote_loop",
        market: { conditionId: "CA", yesTokenId: "TA", noTokenId: "TB" },
        sizeShares: 100,
        targetSpreadCents: 2,
        requoteToleranceCents: 1,
        maxInventoryShares: 200,
        maxCapitalUsd: 100,
        maxDailyLossUsd: 10,
      },
    });
    const codes = validateStrategyDefinition(def).map((i) => i.code);
    expect(codes).toContain("QUOTE_LOOP_TRAILING_GATE");
  });
});

describe("simulateTriggers: trailing", () => {
  const T0 = 1_750_000_000_000; // ms
  const MIN = 60_000;
  const series = (prices: number[]) => prices.map((p, i) => ({ t: T0 + i * MIN, p }));

  it("stop fires at the first sample ≤ peak − offset; arming sample never fires", () => {
    const res = simulateTriggers({
      expr: wrap(stopLeaf(0.05)),
      holdsForMs: 0,
      recurrence: { kind: "once" },
      action: { kind: "alert" },
      series: series([0.5, 0.55, 0.6, 0.58, 0.55, 0.5]),
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1);
    expect(res.triggers[0]!.price).toBe(0.55); // peak 0.60 − 0.05
  });

  it("a single falling sample can't fire on its own arming observation", () => {
    const res = simulateTriggers({
      expr: wrap(stopLeaf(0.05)),
      holdsForMs: 0,
      recurrence: { kind: "once" },
      action: { kind: "alert" },
      series: series([0.5, 0.49, 0.48, 0.47, 0.46]),
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    // Peak stays the first sample (0.50); fires when price ≤ 0.45 — never here.
    expect(res.triggers).toHaveLength(0);
  });

  it("entry fires on the rebound off the trough", () => {
    const res = simulateTriggers({
      expr: wrap(entryLeaf(0.05)),
      holdsForMs: 0,
      recurrence: { kind: "once" },
      action: { kind: "alert" },
      series: series([0.5, 0.45, 0.4, 0.42, 0.46]),
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1);
    expect(res.triggers[0]!.price).toBe(0.46); // trough 0.40 + 0.05 ≤ 0.46
  });

  it("repeat recurrence re-arms after each trigger", () => {
    const res = simulateTriggers({
      expr: wrap(stopLeaf(0.05)),
      holdsForMs: 0,
      recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 0 },
      action: { kind: "alert" },
      // Two full rise-fall cycles.
      series: series([0.5, 0.6, 0.54, 0.5, 0.6, 0.54]),
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(2);
  });

  it("a series gap resets the hold window but not the watermark", () => {
    const pts = [
      { t: T0, p: 0.5 },
      { t: T0 + MIN, p: 0.6 },
      // 3-hour hole (>> maxBridge), then a drop through the trigger level.
      { t: T0 + 180 * MIN, p: 0.55 },
    ];
    const res = simulateTriggers({
      expr: wrap(stopLeaf(0.05)),
      holdsForMs: 0,
      recurrence: { kind: "once" },
      action: { kind: "alert" },
      series: pts,
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.triggers).toHaveLength(1); // watermark 0.6 survived the gap
  });
});
