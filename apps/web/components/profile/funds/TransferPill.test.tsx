import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WalletWithdrawalItem } from "@/lib/types";

// ── Mocks ───────────────────────────────────────────────────────────────────

const queryState = {
  withdrawals: {
    withdrawals: [] as WalletWithdrawalItem[],
    bridgeWithdrawals: [],
  },
  deposits: { deposits: [] },
};

vi.mock("@/lib/queries", () => ({
  useFeatureFlags: () => ({ data: { bridgeFunding: true } }),
  useWithdrawals: () => ({ data: queryState.withdrawals, isLoading: false }),
  useBridgeDeposits: () => ({ data: queryState.deposits, isLoading: false }),
  useFundsAssets: () => ({ data: { assets: [] }, isLoading: false }),
  useTradingWalletBalance: () => ({ data: undefined, isLoading: false }),
}));

import { TransferPill } from "./TransferPill";
import { useFundsUi } from "@/lib/funds-ui";

const withdrawal = (over: Partial<WalletWithdrawalItem> = {}): WalletWithdrawalItem => ({
  id: "w1",
  amountUsd: 25,
  destination: "0xme",
  state: "submitted",
  transactionHash: null,
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  queryState.withdrawals = { withdrawals: [], bridgeWithdrawals: [] };
  queryState.deposits = { deposits: [] };
  useFundsUi.setState({
    open: false,
    tab: "topup",
    focusTransferId: null,
    pillDismissedAt: null,
    seenStates: {},
  });
});

describe("TransferPill", () => {
  it("renders nothing while no transfer is in flight", () => {
    render(<TransferPill />);
    expect(screen.queryByTestId("transfer-pill")).toBeNull();
  });

  it("shows the in-flight transfer with live stage copy", () => {
    queryState.withdrawals = { withdrawals: [withdrawal()], bridgeWithdrawals: [] };
    render(<TransferPill />);
    expect(screen.getByTestId("transfer-pill")).toBeInTheDocument();
    expect(screen.getByText("Withdrawing $25.00")).toBeInTheDocument();
    expect(screen.getByText("confirming on Polygon")).toBeInTheDocument();
  });

  it("stays hidden while the Funds sheet is open", () => {
    queryState.withdrawals = { withdrawals: [withdrawal()], bridgeWithdrawals: [] };
    useFundsUi.setState({ open: true });
    render(<TransferPill />);
    expect(screen.queryByTestId("transfer-pill")).toBeNull();
  });

  it("click-through opens the sheet on History focused on the transfer", () => {
    queryState.withdrawals = { withdrawals: [withdrawal()], bridgeWithdrawals: [] };
    render(<TransferPill />);
    fireEvent.click(screen.getByText("Withdrawing $25.00"));
    const state = useFundsUi.getState();
    expect(state.open).toBe(true);
    expect(state.tab).toBe("history");
    expect(state.focusTransferId).toBe("w-w1");
  });

  it("dismiss hides the pill until a newer transfer starts", () => {
    queryState.withdrawals = {
      withdrawals: [withdrawal({ createdAt: new Date(Date.now() - 60_000).toISOString() })],
      bridgeWithdrawals: [],
    };
    const { rerender } = render(<TransferPill />);
    fireEvent.click(screen.getByLabelText("Dismiss transfer status"));
    rerender(<TransferPill />);
    expect(screen.queryByTestId("transfer-pill")).toBeNull();

    // A NEWER transfer re-surfaces the pill.
    queryState.withdrawals = {
      withdrawals: [
        withdrawal({ createdAt: new Date(Date.now() - 60_000).toISOString() }),
        withdrawal({ id: "w2", createdAt: new Date(Date.now() + 60_000).toISOString() }),
      ],
      bridgeWithdrawals: [],
    };
    rerender(<TransferPill />);
    expect(screen.getByTestId("transfer-pill")).toBeInTheDocument();
  });
});
