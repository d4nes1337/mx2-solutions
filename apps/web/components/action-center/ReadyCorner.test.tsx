import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActionCenterItem } from "@/lib/types";

const ackCalls: string[] = [];
vi.mock("@/lib/queries", () => ({
  useAckTrigger: () => ({ mutate: (id: string) => ackCalls.push(id), isPending: false }),
}));

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

const renderCorner = (props: Partial<Parameters<typeof ReadyCorner>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReadyCorner
        items={[]}
        onReview={() => {}}
        onLater={() => {}}
        onOpenDrawer={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );

describe("ReadyCorner", () => {
  it("renders persistent ready cards with review + not-now, and an overflow link", () => {
    const onReview = vi.fn();
    const onLater = vi.fn();
    const onOpenDrawer = vi.fn();
    renderCorner({
      items: [item("a"), item("b"), item("c"), item("d"), item("e")],
      onReview,
      onLater,
      onOpenDrawer,
    });
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

  it("renders an AUTO_EXECUTED receipt whose Dismiss acknowledges server-side (W5)", () => {
    ackCalls.length = 0;
    const onLater = vi.fn();
    const executed: ActionCenterItem = {
      ...item("x"),
      state: "AUTO_EXECUTED",
      executed: { at: new Date().toISOString(), orderIntentId: "intent-1" },
    };
    renderCorner({ items: [executed], onLater });
    expect(screen.getByText("Executed automatically")).toBeInTheDocument();
    expect(screen.getByText("View details")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Dismiss"));
    // Ack (permanent, cross-device) — never the per-tab snooze.
    expect(ackCalls).toEqual(["x"]);
    expect(onLater).not.toHaveBeenCalled();
  });

  it("renders nothing when no items are ready", () => {
    const { container } = renderCorner();
    expect(container.firstChild).toBeNull();
  });
});
