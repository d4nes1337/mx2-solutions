import { describe, it, expect } from "vitest";
import { validateStrategyDefinition } from "./validate-v2.js";
import type { MarketRef, OrderActionV2, SeriesRef, StrategyDefinition } from "./types-v2.js";

/** Validation rules specific to rolling series bindings (ADR-0028). */

const marketA: MarketRef = { conditionId: "cond-a", tokenId: "tok-a", outcome: "YES" };

const seriesRef = (over: Partial<SeriesRef> = {}): SeriesRef => ({
  kind: "series",
  seriesSlug: "btc-up-or-down-5m",
  outcome: "Up",
  selector: "current",
  maxEntryPrice: 0.6,
  minRemainingMs: 30_000,
  ...over,
});

const orderAction = (over: Partial<OrderActionV2> = {}): OrderActionV2 => ({
  kind: "order",
  market: marketA,
  rollingSeries: seriesRef(),
  side: "BUY",
  price: 0.6,
  size: 50,
  orderType: "FAK",
  execution: "prepare",
  ...over,
});

const strat = (
  action: OrderActionV2,
  over: Partial<StrategyDefinition> = {},
): StrategyDefinition => ({
  version: 2,
  name: "rolling",
  templateId: null,
  expr: {
    type: "group",
    id: "root",
    op: "and",
    children: [
      {
        type: "condition",
        id: "a",
        condition: {
          kind: "price",
          market: marketA,
          source: "ask",
          comparator: "lte",
          threshold: 0.5,
        },
      },
    ],
  },
  holdsForMs: 0,
  maxDataAgeMs: 30_000,
  action,
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
  ...over,
});

const codes = (d: StrategyDefinition) => validateStrategyDefinition(d).map((i) => i.code);

describe("validateStrategyDefinition: rolling series", () => {
  it("accepts a well-formed rolling order", () => {
    expect(codes(strat(orderAction()))).toEqual([]);
  });

  it("rejects resting order types — a fill after the guard defeats the guard", () => {
    expect(codes(strat(orderAction({ orderType: "GTC" })))).toContain("SERIES_REQUIRES_IMMEDIATE");
    expect(codes(strat(orderAction({ orderType: "GTD", expiresAfterMs: 180_000 })))).toContain(
      "SERIES_REQUIRES_IMMEDIATE",
    );
    expect(codes(strat(orderAction({ orderType: "FOK" })))).not.toContain(
      "SERIES_REQUIRES_IMMEDIATE",
    );
  });

  it("rejects malformed series parameters", () => {
    expect(
      codes(strat(orderAction({ rollingSeries: seriesRef({ seriesSlug: "Not A Slug" }) }))),
    ).toContain("SERIES_PARAMS_INVALID");
    expect(codes(strat(orderAction({ rollingSeries: seriesRef({ outcome: "  " }) })))).toContain(
      "SERIES_PARAMS_INVALID",
    );
    expect(
      codes(strat(orderAction({ rollingSeries: seriesRef({ maxEntryPrice: 1.4 }) }))),
    ).toContain("SERIES_PARAMS_INVALID");
    // A time floor longer than a whole 5-minute window can never be satisfied.
    expect(
      codes(strat(orderAction({ rollingSeries: seriesRef({ minRemainingMs: 600_000 }) }))),
    ).toContain("SERIES_PARAMS_INVALID");
  });

  it("lets a ROLLING signed order repeat — each confirmation dies with its window", () => {
    const repeating = strat(orderAction(), {
      recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 0 },
    });
    expect(codes(repeating)).not.toContain("REPEAT_REQUIRES_ALERT_OR_AUTO");
  });

  it("still refuses a repeating FIXED signed order (stale confirmations pile up)", () => {
    const { rollingSeries: _omitted, ...noRolling } = orderAction();
    const fixed = strat(
      { ...noRolling, orderType: "GTC" },
      {
        recurrence: { kind: "repeat", maxRepeats: 3, cooldownMs: 0 },
      },
    );
    expect(codes(fixed)).toContain("REPEAT_REQUIRES_ALERT_OR_AUTO");
  });

  it("does not count the rolling target toward the watched-market cap", () => {
    // The anchor is never subscribed, so it must not consume one of the four
    // market slots a strategy is allowed.
    const issues = codes(strat(orderAction()));
    expect(issues).not.toContain("EXPR_TOO_MANY_MARKETS");
  });
});
