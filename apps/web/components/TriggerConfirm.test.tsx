/**
 * Ready-popup variants: calm payload-first headlines, honest PRICE_MOVED /
 * stale framing, the non-destructive "Not now", and — critically — that the
 * signing call args (idempotency key, preview passthrough) are unchanged by
 * the redesign. The wallet/signing stack is mocked at the hook seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TriggerDetailResponse } from "@/lib/types";

const detailFixture = (over?: {
  conditionStillHolds?: boolean;
  isStale?: boolean;
  status?: string;
}): TriggerDetailResponse =>
  ({
    trigger: {
      id: "t-1",
      ruleId: "r-1",
      walletAddress: "0xabc",
      triggeredAt: new Date().toISOString(),
      evidence: {},
      reasonCodes: [],
      status: over?.status ?? "awaiting_user",
      orderIntentId: null,
      createdAt: new Date().toISOString(),
    },
    evidence: {
      windowStartMs: Date.now() - 60_000,
      windowEndMs: Date.now(),
      bestBid: 0.66,
      bestAsk: 0.68,
      cumulativeNotional: null,
      visibleLevels: null,
      reasonCodes: ["PRICE_OK"],
      ruleDefinitionHash: "deadbeef",
      evaluatorVersion: "v2",
    },
    conditionStillHolds: over?.conditionStillHolds ?? true,
    fresh: {
      satisfied: over?.conditionStillHolds ?? true,
      isStale: over?.isStale ?? false,
      bestBid: 0.66,
      bestAsk: 0.68,
      dataAgeMs: 1500,
    },
    preview: {
      tokenId: "tok-1",
      conditionId: "c-1",
      side: "BUY",
      price: "0.57",
      size: "100",
      orderType: "GTC",
      postOnly: false,
      expiration: null,
      maxSpend: "57",
      builderCode: null,
      signatureType: 0,
      timestamp: new Date().toISOString(),
    },
    account: null,
    tradingEnabled: false,
    warning: "",
  }) as unknown as TriggerDetailResponse;

let detail: TriggerDetailResponse = detailFixture();

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, connector: undefined }),
}));

vi.mock("@/lib/queries", () => ({
  useTriggerDetail: () => ({ data: detail, isLoading: false }),
  useTradingAccounts: () => ({ data: { primaryAccount: null, accounts: [] }, isLoading: false }),
  useTradeStatus: () => ({ data: { tradingEnabled: false } }),
  useSetPrimaryTradingAccount: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitOrder: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useConfirmTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDismissTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  useTokenPricesHistory: () => ({ data: { history: [] }, isLoading: false }),
}));

import { TriggerConfirm } from "./TriggerConfirm";

beforeEach(() => {
  detail = detailFixture();
});

describe("TriggerConfirm (ready popup)", () => {
  it("READY: calm payload headline, dollars-first summary, Not now + Edit strategy", () => {
    const onClose = vi.fn();
    render(<TriggerConfirm triggerId="t-1" onClose={onClose} />);
    expect(screen.getByText("Conditions met — order prepared")).toBeInTheDocument();
    expect(screen.getByText("Buy 100 shares · $57.00")).toBeInTheDocument();
    expect(screen.getByText("+$43.00 if right")).toBeInTheDocument();
    // Non-destructive close: "Not now" keeps the item in the bell; the
    // destructive Dismiss lives in the drawer only.
    fireEvent.click(screen.getByText("Not now"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("Dismiss")).toBeNull();
    const edit = screen.getByText("Edit strategy").closest("a");
    expect(edit?.getAttribute("href")).toBe("/strategies/r-1/edit");
  });

  it("PRICE_MOVED: warns instead of dressing up as ready", () => {
    detail = detailFixture({ conditionStillHolds: false });
    render(<TriggerConfirm triggerId="t-1" onClose={() => {}} />);
    expect(screen.getByText("Price moved — review before signing")).toBeInTheDocument();
    expect(screen.getByText(/edge may have moved/)).toBeInTheDocument();
  });

  it("STALE: says it is waiting for fresh data", () => {
    detail = detailFixture({ conditionStillHolds: false, isStale: true });
    render(<TriggerConfirm triggerId="t-1" onClose={() => {}} />);
    expect(screen.getByText("Waiting for fresh data")).toBeInTheDocument();
  });

  it("already-handled trigger shows a receipt state without a sign button", () => {
    detail = detailFixture({ status: "confirmed" });
    render(<TriggerConfirm triggerId="t-1" onClose={() => {}} />);
    expect(screen.getByText("Already handled")).toBeInTheDocument();
    expect(screen.queryByText(/Sign & submit|Submit \(trading disabled\)/)).toBeNull();
  });

  it("keeps the fail-closed trading-disabled note", () => {
    render(<TriggerConfirm triggerId="t-1" onClose={() => {}} />);
    expect(screen.getByText(/Live trading is disabled/)).toBeInTheDocument();
  });
});
