import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OrderActionV2 } from "@mx2/rules";
import { useBuilderStore } from "@/lib/strategies/store";
import { loadLimitPrefs, saveLimitPrefs } from "@/lib/strategies/limit-prefs";

vi.mock("../MarketSearch", () => ({
  MarketSearch: () => <div>MARKET_SEARCH</div>,
}));

import { OrderActionEditor } from "./OrderActionEditor";
import { ActionEditor } from "./ActionEditor";

const ORDER: OrderActionV2 = {
  kind: "order",
  market: { conditionId: "cond-1", tokenId: "tok-1", outcome: "NO" },
  side: "BUY",
  price: 0.41,
  size: 10,
  orderType: "GTC",
  execution: "prepare",
};

const renderEditor = () => {
  const action = useBuilderStore.getState().doc.action;
  if (action.kind !== "order") throw new Error("store not seeded with an order action");
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OrderActionEditor action={action} />
    </QueryClientProvider>,
  );
};

/** The execution switch moved up into ActionEditor's 3-way picker. */
const renderActionEditor = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActionEditor />
    </QueryClientProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  useBuilderStore.getState().spawnDraft();
  useBuilderStore.getState().setAction({ ...ORDER });
});

describe("OrderActionEditor", () => {
  it("keeps advanced controls collapsed by default", () => {
    const { container } = renderEditor();
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    // Primary essentials are visible without expanding anything.
    expect(screen.getByText("Limit price")).toBeDefined();
    expect(screen.getByText("Side")).toBeDefined();
  });
});

describe("ActionEditor 3-way picker", () => {
  it("orders the choices sign → auto → alert and preselects sign for an order", () => {
    renderActionEditor();
    const labels = [
      screen.getByText("Ask me to sign"),
      screen.getByText("Auto · Arima Wallet"),
      screen.getByText("Alert only"),
    ];
    // DOM order matches the decided priority order.
    expect(
      labels[0]!.compareDocumentPosition(labels[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      labels[1]!.compareDocumentPosition(labels[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/You sign each triggered order/)).toBeDefined();
  });

  it("prefills auto caps from last-used values on switching to Auto", () => {
    saveLimitPrefs({ maxNotionalPerOrder: 10, maxDailyNotional: 15, maxTotalNotional: 15 });
    renderActionEditor();
    fireEvent.click(screen.getByText("Auto · Arima Wallet"));
    expect(useBuilderStore.getState().doc.limits).toEqual({
      maxNotionalPerOrder: 10,
      maxDailyNotional: 15,
      maxTotalNotional: 15,
    });
  });

  it("seeds auto caps from the order cost when nothing was saved", () => {
    renderActionEditor();
    fireEvent.click(screen.getByText("Auto · Arima Wallet"));
    // ceil(0.41 × 10) = 5
    expect(useBuilderStore.getState().doc.limits).toEqual({
      maxNotionalPerOrder: 5,
      maxDailyNotional: 5,
      maxTotalNotional: 5,
    });
  });

  it("never clobbers limits the user already set", () => {
    useBuilderStore
      .getState()
      .setLimits({ maxNotionalPerOrder: 99, maxDailyNotional: 99, maxTotalNotional: 99 });
    renderActionEditor();
    fireEvent.click(screen.getByText("Auto · Arima Wallet"));
    expect(useBuilderStore.getState().doc.limits?.maxNotionalPerOrder).toBe(99);
  });

  it("switching a bound order to alert asks before discarding", () => {
    renderActionEditor();
    fireEvent.click(screen.getByText("Alert only"));
    // ORDER has a bound market → configured → confirmation, not a silent wipe.
    expect(useBuilderStore.getState().doc.action.kind).toBe("order");
    expect(screen.getByText(/discards this action/)).toBeDefined();
    fireEvent.click(screen.getByText("Switch"));
    expect(useBuilderStore.getState().doc.action.kind).toBe("alert");
  });

  it("opens an existing stop_strategy with Advanced expanded and its form intact", () => {
    useBuilderStore.getState().setAction({ kind: "stop_strategy", targetStrategyId: "s-1" });
    const { container } = renderActionEditor();
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(true);
    const action = useBuilderStore.getState().doc.action;
    expect(action.kind).toBe("stop_strategy");
    if (action.kind === "stop_strategy") expect(action.targetStrategyId).toBe("s-1");
  });
});

describe("limit-prefs", () => {
  it("round-trips valid limits", () => {
    saveLimitPrefs({ maxNotionalPerOrder: 1, maxDailyNotional: 2, maxTotalNotional: 3 });
    expect(loadLimitPrefs()).toEqual({
      maxNotionalPerOrder: 1,
      maxDailyNotional: 2,
      maxTotalNotional: 3,
    });
  });

  it("rejects corrupted or partial values", () => {
    localStorage.setItem("arima.smart-orders.limits.v1", "not json");
    expect(loadLimitPrefs()).toBeNull();
    localStorage.setItem(
      "arima.smart-orders.limits.v1",
      JSON.stringify({ maxNotionalPerOrder: -5, maxDailyNotional: 1, maxTotalNotional: 1 }),
    );
    expect(loadLimitPrefs()).toBeNull();
  });
});
