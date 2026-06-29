import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortfolioEquityChart } from "./PortfolioEquityChart";
import type { EquityHistoryResponse } from "@/lib/types";

const data: EquityHistoryResponse = {
  signerAddress: "0x1",
  queryAddress: "0x2",
  window: "30d",
  points: [
    { t: 1, equity: 10 },
    { t: 2, equity: 20 },
  ],
  disclaimer: "Approximate equity curve derived from trade activity.",
  methodology: "Walk TRADE activity chronologically.",
  computedAt: new Date().toISOString(),
};

describe("PortfolioEquityChart", () => {
  it("shows disclaimer text", () => {
    render(<PortfolioEquityChart data={data} window="30d" onWindow={() => {}} />);
    expect(screen.getByText(/Approximate equity curve/)).toBeInTheDocument();
  });
});
