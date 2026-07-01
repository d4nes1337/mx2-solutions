import { describe, expect, it } from "vitest";
import type { ClosedPosition } from "@mx2/polymarket-client";
import { buildEquityHistory } from "./equity-history.js";

const closed = (overrides: Partial<ClosedPosition>): ClosedPosition =>
  ({
    proxyWallet: "0x1",
    asset: "tok",
    conditionId: "0xcond",
    timestamp: 1_700_000_000,
    avgPrice: 0.5,
    totalBought: 10,
    realizedPnl: 5,
    curPrice: 1,
    ...overrides,
  }) as ClosedPosition;

describe("buildEquityHistory", () => {
  it("anchors the latest point to current account PnL", () => {
    const positions = [
      closed({ timestamp: 1_700_000_000, realizedPnl: -10 }),
      closed({ timestamp: 1_700_100_000, realizedPnl: 4 }),
    ];
    const points = buildEquityHistory(positions, 20, "all");
    expect(points[points.length - 1]?.pnl).toBe(20);
  });

  it("filters to 7d window", () => {
    const now = Math.floor(Date.now() / 1000);
    const old = closed({ timestamp: now - 10 * 86400, realizedPnl: -1 });
    const recent = closed({ timestamp: now - 86400, realizedPnl: 2 });
    const points = buildEquityHistory([old, recent], 5, "7d");
    expect(points.every((p) => p.t >= now - 7 * 86400)).toBe(true);
  });
});
