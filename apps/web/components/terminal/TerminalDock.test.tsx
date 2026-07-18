import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

const state = {
  pathname: "/markets",
  session: { data: { allowlisted: true } as unknown } as { data: unknown },
  overview: {
    data: { positions: [{ asset: "a" }, { asset: "b" }] } as unknown,
    isLoading: false,
    error: null as unknown,
  },
  openOrders: {
    data: { openOrders: [{ id: "o1" }], setupRequired: false } as unknown,
    isLoading: false,
    error: null as unknown,
  },
  strategies: {
    data: {
      strategies: [
        {
          id: "s1",
          status: "ACTIVE_ACCUMULATING",
          archivedAt: null,
          name: "Dip buy",
          trueSince: new Date().toISOString(),
          definitionV2: {
            version: 2,
            name: "Dip buy",
            templateId: null,
            expr: { type: "group", id: "root", op: "and", children: [] },
            holdsForMs: 900_000,
            maxDataAgeMs: 30_000,
            action: { kind: "alert" },
            recurrence: { kind: "once" },
            limits: null,
            expiresAtMs: null,
          },
        },
        {
          id: "s2",
          status: "CANCELLED",
          archivedAt: null,
          name: "Ended",
          trueSince: null,
          definitionV2: {
            version: 2,
            name: "Ended",
            templateId: null,
            expr: { type: "group", id: "root", op: "and", children: [] },
            holdsForMs: 0,
            maxDataAgeMs: 30_000,
            action: { kind: "alert" },
            recurrence: { kind: "once" },
            limits: null,
            expiresAtMs: null,
          },
        },
      ],
    } as unknown,
    isLoading: false,
  },
};

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/lib/auth", () => ({ useSession: () => state.session }));
vi.mock("@/lib/queries", () => ({
  usePortfolioOverview: () => state.overview,
  useOpenOrders: () => state.openOrders,
  useTradeStatus: () => ({ data: { tradingEnabled: false } }),
  useCancelOrder: () => ({ mutateAsync: async () => ({}) }),
}));
vi.mock("@/lib/smart-orders/queries", () => ({
  useStrategies: () => state.strategies,
}));
vi.mock("@/components/PositionsTable", () => ({
  PositionsTable: ({ positions }: { positions: unknown[] }) => (
    <div>POSITIONS_TABLE:{positions.length}</div>
  ),
}));
vi.mock("@/components/portfolio/OpenOrdersTable", () => ({
  OpenOrdersTable: ({ orders }: { orders: unknown[] }) => <div>ORDERS_TABLE:{orders.length}</div>,
}));

import { TerminalDock } from "./TerminalDock";

const renderDock = (ui: ReactElement = <TerminalDock />) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  state.pathname = "/markets";
  state.session = { data: { allowlisted: true } };
  localStorage.clear();
});

describe("TerminalDock", () => {
  it("shows the collapsed summary with live counts (terminal strategies excluded)", () => {
    renderDock();
    expect(screen.getByText("2 positions · 1 open order · 1 strategy")).toBeDefined();
  });

  it("renders nothing signed out or on excluded paths", () => {
    state.session = { data: null };
    const qc = new QueryClient();
    const { container, rerender } = render(
      <QueryClientProvider client={qc}>
        <TerminalDock />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");

    state.session = { data: { allowlisted: true } };
    state.pathname = "/smart-orders/new";
    rerender(
      <QueryClientProvider client={qc}>
        <TerminalDock />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");

    state.pathname = "/smart-orders/abc/edit";
    rerender(
      <QueryClientProvider client={qc}>
        <TerminalDock />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");

    state.pathname = "/wallet";
    rerender(
      <QueryClientProvider client={qc}>
        <TerminalDock />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe("");
  });

  it("expands to tabs and switches between them", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("POSITIONS_TABLE:2")).toBeDefined();
    fireEvent.click(screen.getByText("Open orders (1)"));
    expect(screen.getByText("ORDERS_TABLE:1")).toBeDefined();
    fireEvent.click(screen.getByText("Strategies (1)"));
    expect(screen.getByText("Dip buy")).toBeDefined();
    // The terminal (CANCELLED) strategy never appears.
    expect(screen.queryByText("Ended")).toBeNull();
  });

  it("persists open state + tab to localStorage", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByText("Strategies (1)"));
    const saved = JSON.parse(localStorage.getItem("arima.dock.v1") ?? "{}") as {
      open?: boolean;
      tab?: string;
    };
    expect(saved.open).toBe(true);
    expect(saved.tab).toBe("strategies");
  });
});
