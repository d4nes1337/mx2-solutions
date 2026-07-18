import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { FundsAsset } from "@/lib/types";

// ── Mocks ───────────────────────────────────────────────────────────────────

const inertMutation = () => ({
  mutate: vi.fn(),
  data: undefined,
  isIdle: true,
  isPending: false,
  isError: false,
  error: null,
});

const wagmiState = {
  account: {
    address: undefined as `0x${string}` | undefined,
    chainId: undefined as number | undefined,
  },
};

vi.mock("wagmi", () => ({
  useAccount: () => wagmiState.account,
  useBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useWriteContract: () => ({
    writeContract: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
  }),
  useSendTransaction: () => ({
    sendTransaction: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/wagmi", () => ({
  BRIDGE_SEND_CHAIN_IDS: { "137": 137, "8453": 8453, "42161": 42161, "1": 1, "10": 10, "56": 56 },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const asset = (
  chainId: string,
  chainName: string,
  addressType: FundsAsset["addressType"],
  symbol: string,
  address: string,
  minCheckoutUsd = 2,
): FundsAsset => ({
  id: `${chainId}:${address.toLowerCase()}`,
  chainId,
  chainName,
  addressType,
  minCheckoutUsd,
  token: { name: `${symbol} token`, symbol, address, decimals: 6 },
});

const CATALOG: FundsAsset[] = [
  asset("1", "Ethereum", "evm", "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 5),
  asset("1", "Ethereum", "evm", "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 5),
  asset("1", "Ethereum", "evm", "ETH", NATIVE, 5),
  asset("8453", "Base", "evm", "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  asset("137", "Polygon", "evm", "USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
  asset("137", "Polygon", "evm", "USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
  asset("1151111081099710", "Solana", "svm", "SOL", "11111111111111111111111111111111"),
  asset("728126428", "Tron", "tvm", "USDT", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 7),
  asset("8253038", "Bitcoin", "btc", "BTC", "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", 7),
];

const ADDRESSES = {
  evm: "0x3333333333333333333333333333333333333333",
  svm: "So1anaBridgeAddr11111111111111111111111111",
  btc: "bc1bridgeaddrqqqqqqqqqqqqqqqqqqqqqqqqq",
  tvm: "TBridgeAddr1111111111111111111111",
};

const queryState = {
  flags: { bridgeFunding: true, walletWithdraw: false, bridgeWithdrawals: false },
  assets: { enabled: true, assets: CATALOG, chains: [] },
  saved: {
    ok: true,
    depositWalletAddress: "0x9999999999999999999999999999999999999999",
    addresses: ADDRESSES as Partial<Record<string, string>>,
  },
  createMutation: inertMutation(),
};

vi.mock("@/lib/queries", () => ({
  useFeatureFlags: () => ({ data: queryState.flags }),
  useFundsAssets: (enabled = true) => ({
    data: enabled ? queryState.assets : undefined,
    isLoading: false,
    error: null,
  }),
  useSavedDepositAddresses: (enabled = true) => ({
    data: enabled ? queryState.saved : undefined,
    isSuccess: enabled,
    isLoading: false,
    error: null,
  }),
  useBridgeDepositAddresses: () => queryState.createMutation,
  useBridgeQuote: () => inertMutation(),
  useWithdraw: () => inertMutation(),
  useWithdrawals: () => ({ data: undefined, isLoading: false }),
  useBridgeDeposits: () => ({ data: undefined, isLoading: false }),
}));

import { FundsSheet } from "./FundsSheet";

const sheet = () => (
  <FundsSheet
    open
    onClose={() => {}}
    depositWalletAddress="0x9999999999999999999999999999999999999999"
    signerAddress={null}
  />
);

beforeEach(() => {
  queryState.flags = { bridgeFunding: true, walletWithdraw: false, bridgeWithdrawals: false };
  queryState.saved = {
    ok: true,
    depositWalletAddress: "0x9999999999999999999999999999999999999999",
    addresses: ADDRESSES,
  };
  queryState.createMutation = inertMutation();
  wagmiState.account = { address: undefined, chainId: undefined };
});

describe("FundsSheet top-up (bridge-first)", () => {
  it("renders popular token chips and defaults to USDC on Ethereum with QR", () => {
    render(sheet());
    for (const chip of ["USDC", "USDT", "ETH", "SOL", "BTC"]) {
      expect(screen.getByRole("button", { name: chip })).toBeInTheDocument();
    }
    expect(screen.getByText("Deposit USDC on Ethereum")).toBeInTheDocument();
    expect(screen.getByText(ADDRESSES.evm)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Deposit address QR code" })).toBeInTheDocument();
    expect(screen.getByText("min $5")).toBeInTheDocument();
  });

  it("never shows staging jargon or leads with USDC.e", () => {
    render(sheet());
    expect(screen.queryByText(/staged behind a server flag/i)).toBeNull();
    expect(screen.queryByText(/USDC\.e/)).toBeNull();
  });

  it("defaults the network to the connected wallet's chain when supported", () => {
    wagmiState.account = { address: "0xabc0000000000000000000000000000000000abc", chainId: 8453 };
    render(sheet());
    expect(screen.getByText("Deposit USDC on Base")).toBeInTheDocument();
  });

  it("switches family address when picking a non-EVM token", () => {
    render(sheet());
    fireEvent.click(screen.getByRole("button", { name: "SOL" }));
    expect(screen.getByText("Deposit SOL on Solana")).toBeInTheDocument();
    expect(screen.getByText(ADDRESSES.svm)).toBeInTheDocument();
  });

  it("finds exotic routes through the More search (USDT on Tron)", () => {
    render(sheet());
    fireEvent.click(screen.getByRole("button", { name: "More ▾" }));
    fireEvent.change(screen.getByPlaceholderText(/Search .* assets/), {
      target: { value: "tron" },
    });
    fireEvent.click(screen.getByRole("button", { name: /USDT token Tron/ }));
    expect(screen.getByText("Deposit USDT on Tron")).toBeInTheDocument();
    expect(screen.getByText(ADDRESSES.tvm)).toBeInTheDocument();
    expect(screen.getByText("min $7")).toBeInTheDocument();
  });

  it("auto-generates addresses exactly once when none are saved yet", () => {
    queryState.saved = {
      ok: true,
      depositWalletAddress: "0x9999999999999999999999999999999999999999",
      addresses: {},
    };
    render(sheet());
    expect(queryState.createMutation.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Preparing your deposit address…")).toBeInTheDocument();
  });

  it("falls back to the direct Polygon flow without jargon when funding is off", () => {
    queryState.flags = { bridgeFunding: false, walletWithdraw: false, bridgeWithdrawals: false };
    render(sheet());
    expect(screen.getByText("Deposit USDC.e on Polygon")).toBeInTheDocument();
    expect(screen.getByText("0x9999999999999999999999999999999999999999")).toBeInTheDocument();
    expect(screen.queryByText(/staged behind a server flag/i)).toBeNull();
    expect(screen.queryByText(/server flag/i)).toBeNull();
  });
});
