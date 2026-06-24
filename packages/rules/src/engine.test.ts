import { describe, it, expect } from "vitest";
import { evaluatePredicates } from "./evaluate.js";
import { hashDefinition } from "./evidence.js";
import { runReplay } from "./replay.js";
import { initialRuntime, transition } from "./state-machine.js";
import type { EvalEvent, MarketDataView, RuleDefinition } from "./types.js";

const WINDOW = 600_000; // 10 minutes

const def = (over: Partial<RuleDefinition> = {}): RuleDefinition => ({
  version: 1,
  tokenId: "T",
  conditionId: "C",
  outcomeSide: "BUY",
  predicates: [
    { kind: "price", source: "ask", comparator: "lte", threshold: 0.5 },
    { kind: "cumulative_notional", source: "ask", priceBound: 0.5, minNotional: 1000 },
    { kind: "visible_levels", source: "ask", priceBound: 0.5, minLevels: 3 },
  ],
  continuousWindowMs: WINDOW,
  maxDataAgeMs: 2_000,
  action: { kind: "prepare_order", side: "BUY", price: 0.49, size: 100, orderType: "GTC" },
  recurrence: "once",
  expiresAtMs: null,
  ...over,
});

const satisfyingAsks = [
  { price: 0.48, size: 1000 },
  { price: 0.49, size: 1000 },
  { price: 0.5, size: 1000 },
];

const view = (sourceTimeMs: number, over: Partial<MarketDataView> = {}): MarketDataView => ({
  tokenId: "T",
  conditionId: "C",
  asks: satisfyingAsks,
  bids: [{ price: 0.47, size: 500 }],
  marketStatus: "open",
  sourceTimeMs,
  receivedAtMs: sourceTimeMs,
  ...over,
});

const book = (nowMs: number, over: Partial<MarketDataView> = {}): EvalEvent => ({
  type: "book",
  view: view(nowMs, over),
  nowMs,
});

describe("evaluatePredicates (canonical WHEN clause)", () => {
  it("is satisfied when price, notional and levels all hold", () => {
    const e = evaluatePredicates(def(), view(0));
    expect(e.satisfied).toBe(true);
    expect(e.results.map((r) => r.reason)).toEqual(["PRICE_OK", "NOTIONAL_OK", "LEVELS_OK"]);
  });
  it("fails when best ask exceeds the price threshold", () => {
    const e = evaluatePredicates(def(), view(0, { asks: [{ price: 0.55, size: 5000 }] }));
    expect(e.satisfied).toBe(false);
    expect(e.results[0]?.reason).toBe("PRICE_FAIL");
  });
});

describe("continuous-duration trigger", () => {
  it("triggers exactly once after the window of continuous truth", () => {
    const events: EvalEvent[] = [book(0), book(200_000), book(400_000), book(WINDOW)];
    const r = runReplay(def(), events);
    expect(r.finalState.status).toBe("TRIGGERED_AWAITING_USER");
    expect(r.triggers).toHaveLength(1);
    const t = r.triggers[0]!;
    expect(t.windowStartMs).toBe(0);
    expect(t.windowEndMs).toBe(WINDOW);
    expect(t.bestAsk).toBe(0.48);
    expect(t.cumulativeNotional).toBe(1470);
    expect(t.visibleLevels).toBe(3);
    expect(t.reasonCodes).toContain("WINDOW_COMPLETE");
    expect(t.preparedAction).toEqual(def().action);
    expect(r.transitions.map((x) => `${x.from}->${x.to}`)).toEqual([
      "ACTIVE_WAITING->ACTIVE_ACCUMULATING",
      "ACTIVE_ACCUMULATING->TRIGGERED_AWAITING_USER",
    ]);
  });

  it("does not trigger a second time once terminal (single trigger)", () => {
    const events: EvalEvent[] = [book(0), book(WINDOW), book(WINDOW + 200_000), book(WINDOW * 2)];
    const r = runReplay(def(), events);
    expect(r.triggers).toHaveLength(1);
    expect(r.finalState.status).toBe("TRIGGERED_AWAITING_USER");
  });

  it("does not trigger one event before the window completes", () => {
    const r = runReplay(def(), [book(0), book(WINDOW - 1)]);
    expect(r.finalState.status).toBe("ACTIVE_ACCUMULATING");
    expect(r.triggers).toHaveLength(0);
  });
});

describe("timer resets (fail-closed)", () => {
  it("resets when a predicate goes false mid-window", () => {
    const r = runReplay(def(), [
      book(0),
      book(100_000, { asks: [{ price: 0.55, size: 5000 }] }), // price fail
      book(200_000), // satisfied again, but window restarts here
    ]);
    expect(r.finalState.status).toBe("ACTIVE_ACCUMULATING");
    expect(r.finalState.trueSinceMs).toBe(200_000);
    expect(r.triggers).toHaveLength(0);
  });

  it("resets when data goes stale (tick with an old latest view)", () => {
    const r = runReplay(def(), [
      book(0),
      { type: "tick", latestView: view(0), nowMs: 100_000 }, // age 100s > 2s
    ]);
    expect(r.finalState.status).toBe("ACTIVE_WAITING");
    expect(r.finalState.trueSinceMs).toBeNull();
  });

  it("resets on reconnect during accumulation", () => {
    const r = runReplay(def(), [book(0), { type: "reconnect", nowMs: 100_000 }]);
    expect(r.finalState.status).toBe("ACTIVE_WAITING");
  });

  it("resets on a tick-size change during accumulation", () => {
    const r = runReplay(def(), [book(0), { type: "tick_size_change", nowMs: 100_000 }]);
    expect(r.finalState.status).toBe("ACTIVE_WAITING");
    expect(r.transitions.at(-1)?.reason).toBe("TICK_SIZE_CHANGED");
  });
});

describe("invalidation / lifecycle", () => {
  it("invalidates when the market closes", () => {
    const r = runReplay(def(), [
      book(0),
      { type: "market_status", status: "closed", nowMs: 100_000 },
    ]);
    expect(r.finalState.status).toBe("INVALIDATED");
  });

  it("invalidates when an incoming book shows resolved status", () => {
    const r = runReplay(def(), [book(0), book(100_000, { marketStatus: "resolved" })]);
    expect(r.finalState.status).toBe("INVALIDATED");
  });

  it("expires on a tick after the rule expiry with no data", () => {
    const r = runReplay(def({ expiresAtMs: 50_000 }), [
      book(0),
      { type: "tick", latestView: null, nowMs: 60_000 },
    ]);
    expect(r.finalState.status).toBe("EXPIRED");
  });

  it("pause halts accumulation; resume restarts waiting", () => {
    const paused = transition(
      def(),
      { ...initialRuntime(), status: "ACTIVE_ACCUMULATING", trueSinceMs: 0 },
      {
        type: "pause",
        nowMs: 10_000,
      },
    );
    expect(paused.runtime.status).toBe("PAUSED");
    const ignored = transition(def(), paused.runtime, book(20_000));
    expect(ignored.runtime.status).toBe("PAUSED"); // ignores data while paused
    const resumed = transition(def(), paused.runtime, { type: "resume", nowMs: 30_000 });
    expect(resumed.runtime.status).toBe("ACTIVE_WAITING");
  });

  it("cancel is terminal", () => {
    const r = runReplay(def(), [book(0), { type: "cancel", nowMs: 5_000 }, book(WINDOW)]);
    expect(r.finalState.status).toBe("CANCELLED");
    expect(r.triggers).toHaveLength(0);
  });
});

describe("definition hash", () => {
  it("is stable regardless of key order and changes with content", () => {
    expect(hashDefinition(def())).toBe(hashDefinition(def()));
    expect(hashDefinition(def())).not.toBe(hashDefinition(def({ continuousWindowMs: 1 })));
  });
});
