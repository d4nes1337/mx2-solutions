import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PnLSummary } from "./PnLSummary";
import type { PnlResponse } from "@/lib/types";

const data: PnlResponse = {
  signerAddress: "0xsigner",
  queryAddress: "0xquery",
  computedAt: new Date().toISOString(),
  dataSource: "Polymarket Data API",
  summary: {
    unrealizedPnl: "12.3400",
    realizedPnl: "-4.5600",
    totalPnl: "7.7800",
    currentPortfolioValue: "100.0000",
    openPositions: 3,
  },
  methodology: "Unrealized PnL = sum(currentValue − initialValue).",
  limitations: ["Pre-beta history may be incomplete", "USDC transfers are not tracked"],
};

describe("PnLSummary", () => {
  it("renders summary figures", () => {
    render(<PnLSummary data={data} />);
    expect(screen.getByText("Portfolio value")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("$+7.78")).toBeInTheDocument();
  });

  it("always surfaces methodology and every limitation (required)", () => {
    render(<PnLSummary data={data} />);
    expect(screen.getByText(/Unrealized PnL = sum/)).toBeInTheDocument();
    for (const limitation of data.limitations) {
      expect(screen.getByText(limitation)).toBeInTheDocument();
    }
  });
});
