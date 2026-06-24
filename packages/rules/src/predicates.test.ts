import { describe, it, expect } from "vitest";
import {
  bestAsk,
  bestBid,
  cumulativeNotional,
  cumulativeShares,
  dataAgeMs,
  round6,
  spread,
  visibleLevels,
} from "./predicates.js";
import type { MarketDataView } from "./types.js";

const view = (over: Partial<MarketDataView> = {}): MarketDataView => ({
  tokenId: "T",
  conditionId: "C",
  asks: [
    { price: 0.48, size: 1000 },
    { price: 0.49, size: 1000 },
    { price: 0.5, size: 1000 },
  ],
  bids: [{ price: 0.47, size: 500 }],
  marketStatus: "open",
  sourceTimeMs: 0,
  receivedAtMs: 0,
  ...over,
});

describe("round6", () => {
  it("pins notional rounding to USDC 6dp without float drift", () => {
    // 0.49 * 1000 would be 489.99999999999994 under naive float math.
    expect(round6(0.49 * 1000)).toBe(490);
    expect(round6(0.1 + 0.2)).toBe(0.3);
  });
});

describe("best prices / spread", () => {
  it("reads best-first levels and computes spread", () => {
    const v = view();
    expect(bestAsk(v)).toBe(0.48);
    expect(bestBid(v)).toBe(0.47);
    expect(spread(v)).toBe(0.01);
  });
  it("returns null when a side is empty", () => {
    expect(bestAsk(view({ asks: [] }))).toBeNull();
    expect(spread(view({ bids: [] }))).toBeNull();
  });
});

describe("cumulative notional / shares within band", () => {
  it("sums price*size for ask levels at price <= bound", () => {
    // 0.48*1000 + 0.49*1000 + 0.50*1000 = 1470
    expect(cumulativeNotional(view(), "ask", 0.5)).toBe(1470);
    expect(cumulativeShares(view(), "ask", 0.5)).toBe(3000);
  });
  it("excludes levels outside the band", () => {
    expect(cumulativeNotional(view(), "ask", 0.49)).toBe(0.48 * 1000 + 0.49 * 1000);
    expect(visibleLevels(view(), "ask", 0.49)).toBe(2);
  });
  it("counts only non-empty visible levels", () => {
    const v = view({
      asks: [
        { price: 0.48, size: 0 },
        { price: 0.49, size: 10 },
      ],
    });
    expect(visibleLevels(v, "ask", 0.5)).toBe(1);
  });
});

describe("dataAgeMs", () => {
  it("measures age against the source clock and clamps negatives", () => {
    expect(dataAgeMs(view({ sourceTimeMs: 1000 }), 3000)).toBe(2000);
    expect(dataAgeMs(view({ sourceTimeMs: 5000 }), 3000)).toBe(0); // skew clamp
  });
});
