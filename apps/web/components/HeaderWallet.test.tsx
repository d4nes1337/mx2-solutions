import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const state = {
  session: { data: { allowlisted: true } as unknown } as { data: unknown },
  wallet: {
    data: {
      provisioned: true,
      depositWalletAddress: "0x9999999999999999999999999999999999999999",
      embeddedAddress: "0x1212121212121212121212121212121212121212",
    } as Record<string, unknown> | undefined,
  },
  balance: {
    data: { depositWalletUsdc: 12.5 } as Record<string, unknown> | undefined,
    isLoading: false,
  },
};

vi.mock("@/lib/auth", () => ({ useSession: () => state.session }));
vi.mock("@/lib/queries", () => ({
  useTradingWallet: () => state.wallet,
  useTradingWalletBalance: () => state.balance,
}));
vi.mock("@/components/profile/FundsSheet", () => ({
  FundsSheet: ({ open }: { open: boolean }) => (open ? <div>FUNDS_SHEET_OPEN</div> : null),
}));

import { HeaderWallet } from "./HeaderWallet";

beforeEach(() => {
  state.session = { data: { allowlisted: true } };
  state.wallet = {
    data: {
      provisioned: true,
      depositWalletAddress: "0x9999999999999999999999999999999999999999",
      embeddedAddress: "0x1212121212121212121212121212121212121212",
    },
  };
  state.balance = { data: { depositWalletUsdc: 12.5 }, isLoading: false };
});

describe("HeaderWallet", () => {
  it("shows the pUSD balance and opens the funds sheet on Deposit", () => {
    render(<HeaderWallet />);
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.queryByText("FUNDS_SHEET_OPEN")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("FUNDS_SHEET_OPEN")).toBeInTheDocument();
  });

  it("renders nothing when signed out", () => {
    state.session = { data: undefined };
    const { container } = render(<HeaderWallet />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing until the deposit wallet exists", () => {
    state.wallet = { data: { provisioned: true, depositWalletAddress: null } };
    const { container } = render(<HeaderWallet />);
    expect(container).toBeEmptyDOMElement();
  });
});
