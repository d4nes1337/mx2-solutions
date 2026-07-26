import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActionCenterItem } from "@/lib/types";
import { ReadyCorner } from "./ReadyCorner";

const item = (id: string, name = `Strategy ${id}`): ActionCenterItem => ({
  triggerId: id,
  ruleId: `r-${id}`,
  ruleName: name,
  triggeredAt: new Date().toISOString(),
  state: "READY_TO_SIGN",
  market: { conditionId: "c", tokenId: "t", title: "M", outcome: "YES" },
  conditionSummary: "YES ≥ 67¢",
  actual: "68¢",
  threshold: "67¢",
  dataAgeMs: 1200,
  account: null,
  action: { side: "BUY", sizeShares: 100, price: "0.57", maxSpendUsd: "57", orderType: "GTC" },
});

describe("ReadyCorner", () => {
  it("renders persistent ready cards with review + not-now, and an overflow link", () => {
    const onReview = vi.fn();
    const onLater = vi.fn();
    const onOpenDrawer = vi.fn();
    render(
      <ReadyCorner
        items={[item("a"), item("b"), item("c"), item("d"), item("e")]}
        onReview={onReview}
        onLater={onLater}
        onOpenDrawer={onOpenDrawer}
      />,
    );
    // Capped at 3 visible + overflow into the bell.
    expect(screen.getAllByText("Conditions met")).toHaveLength(3);
    expect(screen.getByText("+2 more ready in the bell")).toBeInTheDocument();
    expect(screen.getAllByText(/Buy 100 YES at up to 57¢/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText("Review & sign")[0]!);
    expect(onReview).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByText("Not now")[0]!);
    expect(onLater).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByText("+2 more ready in the bell"));
    expect(onOpenDrawer).toHaveBeenCalled();
  });

  it("renders nothing when no items are ready", () => {
    const { container } = render(
      <ReadyCorner items={[]} onReview={() => {}} onLater={() => {}} onOpenDrawer={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
