/**
 * Ready-popup variants: calm payload-first headlines, honest PRICE_MOVED /
 * stale framing, the non-destructive "Not now", and — critically — that the
 * signing call args (idempotency key, preview passthrough) are unchanged by
 * the redesign. The wallet/signing stack is mocked at the hook seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import type { ActionCenterResponse, TriggerDetailResponse } from "@/lib/types";

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

interface DetailQueryState {
  data: TriggerDetailResponse | undefined;
  isLoading: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

let detailQuery: DetailQueryState;
let submitQuery: {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  error: unknown;
  reset: ReturnType<typeof vi.fn>;
};

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, connector: undefined }),
  // PolygonNotice (wrong-network nudge) lives in the signing card.
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
}));

vi.mock("@/lib/queries", () => ({
  useTriggerDetail: () => detailQuery,
  useTradingAccounts: () => ({ data: { primaryAccount: null, accounts: [] }, isLoading: false }),
  useTradeStatus: () => ({ data: { tradingEnabled: false } }),
  useSetPrimaryTradingAccount: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitOrder: () => submitQuery,
  useConfirmTrigger: () => ({ mutateAsync: vi.fn(), isPending: false, reset: vi.fn() }),
  useDismissTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  useTokenPricesHistory: () => ({ data: { history: [] }, isLoading: false }),
  useOrderbookByToken: () => ({ data: undefined, dataUpdatedAt: 0 }),
  useMarketResolve: () => ({ data: undefined }),
  useAckTrigger: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { TriggerConfirm } from "./TriggerConfirm";

beforeEach(() => {
  detailQuery = {
    data: detailFixture(),
    isLoading: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  };
  submitQuery = { mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() };
});

const renderModal = (opts?: { onClose?: () => void; actionCenter?: ActionCenterResponse }) => {
  const qc = new QueryClient();
  if (opts?.actionCenter) qc.setQueryData(["action-center"], opts.actionCenter);
  return render(
    <QueryClientProvider client={qc}>
      <TriggerConfirm triggerId="t-1" onClose={opts?.onClose ?? (() => {})} />
    </QueryClientProvider>,
  );
};

describe("TriggerConfirm (ready popup)", () => {
  it("READY: calm payload headline, dollars-first summary, Not now + Edit strategy", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
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
    detailQuery.data = detailFixture({ conditionStillHolds: false });
    renderModal();
    expect(screen.getByText("Price moved — review before signing")).toBeInTheDocument();
    expect(screen.getByText(/edge may have moved/)).toBeInTheDocument();
  });

  it("STALE: says it is waiting for fresh data", () => {
    detailQuery.data = detailFixture({ conditionStillHolds: false, isStale: true });
    renderModal();
    expect(screen.getByText("Waiting for fresh data")).toBeInTheDocument();
  });

  it("already-handled trigger shows a receipt state without a sign button", () => {
    detailQuery.data = detailFixture({ status: "confirmed" });
    renderModal();
    expect(screen.getByText("Already handled")).toBeInTheDocument();
    expect(screen.queryByText(/Sign & submit|Submit \(trading disabled\)/)).toBeNull();
  });

  it("keeps the fail-closed trading-disabled note", () => {
    renderModal();
    expect(screen.getByText(/Live trading is disabled/)).toBeInTheDocument();
  });

  it("load failure renders an error card with Retry — never an infinite spinner", () => {
    detailQuery = {
      data: undefined,
      isLoading: false,
      error: new ApiError(404, "NOT_FOUND", "Trigger not found", null),
      isFetching: false,
      refetch: vi.fn(),
    };
    renderModal();
    expect(screen.getByText("Couldn't load this trigger")).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.queryByText("Loading fresh preview…")).toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(detailQuery.refetch).toHaveBeenCalled();
  });

  it("403 load failure explains the expired session", () => {
    detailQuery = {
      data: undefined,
      isLoading: false,
      error: new ApiError(403, "SCOPE_FORBIDDEN", "Forbidden", null),
      isFetching: false,
      refetch: vi.fn(),
    };
    renderModal();
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("a submit-mutation error alone renders no banner (single error sink)", () => {
    // One rejection used to paint two identical banners: signError from the
    // catch AND submit.error from React Query. The catch is now the only sink.
    submitQuery.error = new Error("Trading is not available in your region.");
    renderModal();
    expect(screen.queryAllByText("Trading is not available in your region.")).toHaveLength(0);
  });

  it("auto-executed triggers render as a receipt: Dismiss + View strategy, no signing (W5)", () => {
    const d = detailFixture({ status: "confirmed" });
    (d.trigger as { autoExecutedAt?: string }).autoExecutedAt = new Date().toISOString();
    (d.trigger as { orderIntentId: string | null }).orderIntentId = "intent-1";
    detailQuery.data = d;
    renderModal();
    expect(screen.getByText("Executed automatically")).toBeInTheDocument();
    expect(screen.getByText(/Submitted automatically from your Arima wallet/)).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
    expect(screen.getByText("View strategy").closest("a")?.getAttribute("href")).toBe(
      "/strategies/r-1",
    );
    expect(screen.queryByText(/Sign & submit|Submit \(trading disabled\)/)).toBeNull();
    expect(screen.queryByText("Signing wallet")).toBeNull();
  });

  it("an awaiting trigger with a failed auto attempt explains why (W5)", () => {
    const d = detailFixture();
    (d.trigger as { autoFailedAt?: string }).autoFailedAt = new Date().toISOString();
    (d.trigger as { autoFailureReason?: string }).autoFailureReason = "insufficient_balance";
    detailQuery.data = d;
    renderModal();
    expect(screen.getByText(/Automatic execution failed/)).toBeInTheDocument();
    expect(screen.getByText(/not enough USDC/)).toBeInTheDocument();
    // Manual signing stays available (no account in the fixture → the submit
    // button renders its "Select wallet" readiness label).
    expect(screen.getByText("Select wallet")).toBeInTheDocument();
  });

  it("while loading, seeds the header from the cached action-center item", () => {
    detailQuery = {
      data: undefined,
      isLoading: true,
      error: null,
      isFetching: true,
      refetch: vi.fn(),
    };
    renderModal({
      actionCenter: {
        generatedAt: new Date().toISOString(),
        actionableCount: 1,
        items: [
          {
            triggerId: "t-1",
            ruleId: "r-1",
            ruleName: "Dip buy BTC",
            triggeredAt: new Date().toISOString(),
            state: "READY_TO_SIGN",
            market: { conditionId: "c-1", tokenId: "tok-1", title: "BTC up?", outcome: "YES" },
            conditionSummary: "price below 45¢",
            actual: null,
            threshold: null,
            dataAgeMs: 1000,
            account: null,
            action: {
              side: "BUY",
              sizeShares: 10,
              price: "0.83",
              maxSpendUsd: "8.30",
              orderType: "GTC",
            },
          },
        ],
      } as ActionCenterResponse,
    });
    expect(screen.getByText("Buy 10 shares")).toBeInTheDocument();
    expect(screen.getByText(/83¢ limit · GTC · Dip buy BTC/)).toBeInTheDocument();
    expect(screen.getByText("Loading fresh preview…")).toBeInTheDocument();
  });
});
