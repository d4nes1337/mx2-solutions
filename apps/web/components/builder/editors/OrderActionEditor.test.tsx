import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OrderActionV2 } from "@mx2/rules";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { loadLimitPrefs, saveLimitPrefs } from "@/lib/smart-orders/limit-prefs";

vi.mock("../MarketSearch", () => ({
  MarketSearch: () => <div>MARKET_SEARCH</div>,
}));

import { OrderActionEditor } from "./OrderActionEditor";

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

  it("prefills auto caps from last-used values on switching to Auto", () => {
    saveLimitPrefs({ maxNotionalPerOrder: 10, maxDailyNotional: 15, maxTotalNotional: 15 });
    renderEditor();
    fireEvent.click(screen.getByText("Auto"));
    expect(useBuilderStore.getState().doc.limits).toEqual({
      maxNotionalPerOrder: 10,
      maxDailyNotional: 15,
      maxTotalNotional: 15,
    });
  });

  it("seeds auto caps from the order cost when nothing was saved", () => {
    renderEditor();
    fireEvent.click(screen.getByText("Auto"));
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
    renderEditor();
    fireEvent.click(screen.getByText("Auto"));
    expect(useBuilderStore.getState().doc.limits?.maxNotionalPerOrder).toBe(99);
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
