import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MarketRef } from "@mx2/rules";
import { useBuilderStore } from "@/lib/strategies/store";
import { emptyDoc } from "@/lib/strategies/doc";
import { ArmSheet } from "./ArmSheet";

const market: MarketRef = { conditionId: "c1", tokenId: "tok-1", outcome: "YES", title: "M" };

const orderDoc = () => ({
  ...emptyDoc(),
  action: {
    kind: "order" as const,
    market,
    side: "BUY" as const,
    price: 0.57,
    size: 100,
    orderType: "GTC" as const,
    execution: "prepare" as const,
  },
});

const renderSheet = (over?: Partial<Parameters<typeof ArmSheet>[0]>) => {
  const onArm = vi.fn();
  render(
    <ArmSheet
      open
      onClose={() => {}}
      onArm={onArm}
      arming={false}
      saveError={null}
      autoReadiness={undefined}
      {...over}
    />,
  );
  return { onArm };
};

beforeEach(() => {
  window.localStorage.clear();
  useBuilderStore.getState().reset(orderDoc());
});

describe("ArmSheet", () => {
  it("defaults to ask-me-to-sign with the no-trade trust line, and arms on click", () => {
    const { onArm } = renderSheet();
    expect(screen.getByText("How should this fire?")).toBeInTheDocument();
    expect(screen.getByText(/Nothing trades without your signature/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Arm — start watching"));
    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it("switching to auto prefills spend caps and swaps the trust line", () => {
    renderSheet();
    fireEvent.click(screen.getByText("Auto · Arima Wallet"));
    const doc = useBuilderStore.getState().doc;
    expect(doc.action.kind === "order" && doc.action.execution).toBe("auto");
    // 0.57 × 100 = $57 → rounded up to $60 per-order default cap.
    expect(doc.limits).toEqual({
      maxNotionalPerOrder: 60,
      maxDailyNotional: 120,
      maxTotalNotional: 240,
    });
    expect(screen.getByText("Max per order")).toBeInTheDocument();
    expect(screen.getByText(/Auto trades only within the caps you set/)).toBeInTheDocument();
  });

  it("lists auto blockers when the server says unattended execution is unavailable", () => {
    useBuilderStore.getState().reset({
      ...orderDoc(),
      action: { ...orderDoc().action, execution: "auto" },
    });
    renderSheet({
      autoReadiness: {
        autoExecutionEnabled: false,
        blockers: [{ code: "FLAG_OFF", detail: "Live execution is disabled on the server." }],
      } as never,
    });
    expect(screen.getByText(/Live execution is disabled/)).toBeInTheDocument();
    expect(screen.getByText(/triggers will wait for your confirmation/)).toBeInTheDocument();
  });

  it("skips the fire-mode step entirely for alert-only strategies", () => {
    // emptyDoc now defaults to a prepared order — force the alert action.
    useBuilderStore.getState().reset({ ...emptyDoc(), action: { kind: "alert" } });
    renderSheet();
    expect(screen.queryByText("How should this fire?")).toBeNull();
    expect(screen.getByText("How should we reach you?")).toBeInTheDocument();
  });
});
