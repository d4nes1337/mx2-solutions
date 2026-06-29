import { describe, expect, it } from "vitest";
import type { Activity, Position } from "@mx2/polymarket-client";
import { buildEquityHistory } from "./equity-history.js";

const trade = (overrides: Partial<Activity>): Activity =>
  ({
    proxyWallet: "0x1",
    timestamp: 1_700_000_000,
    type: "TRADE",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    ...overrides,
  }) as Activity;

const position = (currentValue: number): Position =>
  ({
    proxyWallet: "0x1",
    asset: "tok",
    conditionId: "0xcond",
    size: 10,
    avgPrice: 0.5,
    initialValue: 5,
    currentValue,
    cashPnl: 0,
    percentPnl: 0,
    totalBought: 5,
    realizedPnl: 0,
  }) as Position;

describe("buildEquityHistory", () => {
  it("anchors the latest point to current portfolio value", () => {
    const activity = [
      trade({ timestamp: 1_700_000_000, side: "BUY", usdcSize: 10 }),
      trade({ timestamp: 1_700_100_000, side: "SELL", usdcSize: 4 }),
    ];
    const points = buildEquityHistory(activity, [position(20)], "all");
    expect(points[points.length - 1]?.equity).toBe(20);
  });

  it("filters to 7d window", () => {
    const now = Math.floor(Date.now() / 1000);
    const old = trade({ timestamp: now - 10 * 86400, side: "BUY", usdcSize: 1 });
    const recent = trade({ timestamp: now - 86400, side: "SELL", usdcSize: 2 });
    const points = buildEquityHistory([old, recent], [position(5)], "7d");
    expect(points.every((p) => p.t >= now - 7 * 86400)).toBe(true);
  });
});
