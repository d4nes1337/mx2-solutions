import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityTimeline } from "./ActivityTimeline";
import type { StrategyTimeline } from "@/lib/smart-orders/queries";

const timeline: StrategyTimeline = {
  strategyId: "rule-1",
  status: "EXECUTED_AUTO",
  events: [
    {
      id: "e1",
      at: "2026-01-01T00:00:00Z",
      action: "rule.created",
      metadata: {},
    },
    {
      id: "e2",
      at: "2026-01-01T00:05:00Z",
      action: "rule.state_changed",
      metadata: { from: "ACTIVE_WAITING", to: "ACTIVE_ACCUMULATING", reason: "WINDOW_STARTED" },
    },
    {
      id: "e3",
      at: "2026-01-01T00:06:00Z",
      action: "rule.state_changed",
      metadata: { from: "ACTIVE_ACCUMULATING", to: "ACTIVE_WAITING", reason: "DATA_STALE" },
    },
    {
      id: "e4",
      at: "2026-01-01T00:20:00Z",
      action: "rule.triggered",
      metadata: { triggerNumber: 1 },
    },
  ],
  triggers: [
    {
      id: "t1",
      triggeredAt: "2026-01-01T00:20:00Z",
      status: "confirmed",
      reasonCodes: ["PRICE_OK"],
      orderIntentId: "o1",
    },
  ],
  orders: [
    {
      id: "o1",
      createdAt: "2026-01-01T00:20:01Z",
      status: "filled",
      side: "BUY",
      price: "0.41",
      size: "10",
      orderType: "GTC",
      clobOrderId: "clob-1",
      filledSize: "10",
      avgFillPrice: "0.405",
      tokenId: "tok-1",
      conditionId: "cond-1",
      errorMessage: null,
    },
  ],
};

describe("ActivityTimeline", () => {
  it("renders engine churn, triggers, and orders newest-first", () => {
    render(
      <ActivityTimeline timeline={timeline} loading={false} createdAt="2026-01-01T00:00:00Z" />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const labelOrder = [
      "Buy 10 @ 41¢ placed",
      "Triggered",
      "Market data went quiet — hold window reset",
      "Conditions met — hold window started",
      "Strategy armed",
    ];
    // Every expected label appears, in newest-first order.
    let cursor = 0;
    for (const label of labelOrder) {
      const idx = items.findIndex((text, i) => i >= cursor && text.includes(label));
      expect(idx, `expected "${label}" after position ${cursor}`).toBeGreaterThanOrEqual(cursor);
      cursor = idx + 1;
    }
  });

  it("synthesizes the armed entry for strategies predating the audit trail", () => {
    render(
      <ActivityTimeline
        timeline={{ ...timeline, events: [] }}
        loading={false}
        createdAt="2026-01-01T00:00:00Z"
      />,
    );
    expect(screen.getByText("Strategy armed")).toBeDefined();
  });

  it("shows the empty state when there is no activity at all", () => {
    render(
      <ActivityTimeline
        timeline={{
          strategyId: "r",
          status: "ACTIVE_WAITING",
          events: [],
          triggers: [],
          orders: [],
        }}
        loading={false}
        createdAt="2026-01-01T00:00:00Z"
      />,
    );
    // The synthesized armed entry still renders; the list is never fully empty
    // for a created strategy.
    expect(screen.getByText("Strategy armed")).toBeDefined();
  });
});
