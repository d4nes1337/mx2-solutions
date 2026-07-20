/** Pulse strip: counts per chip, the closest-distance hint, quiet when idle. */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PulseStrip } from "./PulseStrip";
import type { Section } from "@/lib/smart-orders/sections";
import type { StrategyOverviewItem, StrategyRow } from "@/lib/smart-orders/queries";

const stub = (id: string): StrategyRow => ({ id }) as StrategyRow;

const ov = (id: string, bindingDistance: number | null): [string, StrategyOverviewItem] => [
  id,
  {
    id,
    rank: 0,
    proximity: {
      bindingDistance,
      bindingTokenId: "t",
      drift: null,
      dwellFraction: null,
      blockedBy: [],
      leaves: [],
    },
    actionability: null,
  },
];

describe("PulseStrip", () => {
  it("summarizes actionable sections and the closest distance", () => {
    const sections: Section[] = [
      { section: "ready", rows: [stub("a"), stub("b")] },
      { section: "missed", rows: [stub("c")] },
      { section: "approaching", rows: [stub("d"), stub("e")] },
      { section: "done", rows: [stub("f")] },
    ];
    render(<PulseStrip sections={sections} overview={new Map([ov("d", 0.031), ov("e", 0.012)])} />);
    expect(screen.getByText("2 ready to sign")).toBeDefined();
    expect(screen.getByText("1 missed")).toBeDefined();
    expect(screen.getByText("2 approaching")).toBeDefined();
    expect(screen.getByText(/closest 1\.2¢ away/)).toBeDefined();
    expect(screen.queryByText(/done/i)).toBeNull();
  });

  it("renders nothing when only watching/done exist", () => {
    const { container } = render(
      <PulseStrip
        sections={[
          { section: "watching", rows: [stub("a")] },
          { section: "done", rows: [stub("b")] },
        ]}
        overview={new Map()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
