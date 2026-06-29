import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortfolioMetrics } from "./PortfolioMetrics";
import type { PnlSummary } from "@/lib/types";

const summary: PnlSummary = {
  unrealizedPnl: "12.3400",
  realizedPnl: "-4.5600",
  totalPnl: "7.7800",
  currentPortfolioValue: "100.0000",
  openPositions: 3,
};

describe("PortfolioMetrics", () => {
  it("renders equity and PnL figures", () => {
    render(<PortfolioMetrics summary={summary} usdcBalance="500" openOrderCount={2} />);
    expect(screen.getByText("Equity")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("$+7.78")).toBeInTheDocument();
    expect(screen.getByText(/USDC \$500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/2 open orders/)).toBeInTheDocument();
  });
});
