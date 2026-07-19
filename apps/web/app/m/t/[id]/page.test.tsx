import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api";

const idle = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
});

const detailData = {
  trigger: { id: "trig-1", status: "awaiting_user" },
  evidence: {},
  conditionStillHolds: true,
  fresh: { satisfied: true, isStale: false },
  preview: {
    tokenId: "tok-1",
    conditionId: "cond-1",
    side: "BUY",
    price: "0.45",
    size: "100",
    orderType: "GTC",
    postOnly: false,
    expiration: null,
    maxSpend: "45.000000",
    builderCode: null,
    signatureType: 2,
    timestamp: "1700000000",
  },
  account: {
    id: "acct-1",
    label: "Main",
    signerAddress: "0x1111111111111111111111111111111111111111",
    funderAddress: "0x2222222222222222222222222222222222222222",
    signingMode: "browser",
    credentialsReady: true,
  },
  tradingEnabled: true,
  warning: "Live trading is ENABLED. Submitting this order will use real funds.",
};

const state: {
  detail: { data?: unknown; error?: unknown; isLoading: boolean };
  searchToken: string | null;
} = {
  detail: { data: detailData, isLoading: false },
  searchToken: null,
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "trig-1" }),
  useSearchParams: () => new URLSearchParams(state.searchToken ? `t=${state.searchToken}` : ""),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x1111111111111111111111111111111111111111",
    connector: { getProvider: async () => ({ request: async () => "0xsig" }) },
  }),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: (props: { label?: string }) => <button>{props.label ?? "Connect"}</button>,
}));

vi.mock("@/lib/queries", () => ({
  useExchangeSignLink: () => idle(),
  useTelegramMiniappAuth: () => idle(),
  useTriggerDetail: () => state.detail,
  useSubmitOrder: () => idle(),
  useConfirmTrigger: () => idle(),
  useDismissTrigger: () => idle(),
  useOrderbookByToken: () => ({
    data: {
      tokenId: "tok-1",
      bids: [{ price: "0.44", size: "100" }],
      asks: [{ price: "0.46", size: "100" }],
      isStale: false,
      source: "ws",
      receivedAt: "",
    },
  }),
}));

import MobileSignPage from "./page";

beforeEach(() => {
  state.detail = { data: structuredClone(detailData), isLoading: false };
  state.searchToken = null;
});

describe("mobile sign page", () => {
  it("renders the fresh preview with side, size, price and the mode toggle", () => {
    render(<MobileSignPage />);
    expect(screen.getByText("Order ready to sign")).toBeInTheDocument();
    expect(screen.getByText("BUY 100")).toBeInTheDocument();
    expect(screen.getByText("Limit")).toBeInTheDocument();
    expect(screen.getByText("Market")).toBeInTheDocument();
    expect(screen.getByText("Sign & submit")).toBeInTheDocument();
    // Limit mode initialized from the GTC preview at 45¢.
    expect(screen.getByDisplayValue("45")).toBeInTheDocument();
  });

  it("market mode switches to FAK take-now copy", () => {
    render(<MobileSignPage />);
    fireEvent.click(screen.getByText("Market"));
    expect(screen.getByText(/unfilled remainder is cancelled/)).toBeInTheDocument();
    expect(screen.getByText("FAK")).toBeInTheDocument();
  });

  it("shows the expired-link state on 401", () => {
    state.detail = {
      isLoading: false,
      error: new ApiError(401, "Unauthorized", "Unauthorized", null),
    };
    render(<MobileSignPage />);
    expect(screen.getByText("Sign link expired")).toBeInTheDocument();
    expect(screen.getByText(/\/orders/)).toBeInTheDocument();
  });

  it("shows a terminal note for an already-confirmed trigger", () => {
    (state.detail.data as typeof detailData).trigger.status = "confirmed";
    render(<MobileSignPage />);
    expect(screen.getByText(/already signed and submitted/)).toBeInTheDocument();
  });
});
