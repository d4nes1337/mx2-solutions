import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const state = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as `0x${string}` | undefined,
}));

// Avoid loading the RainbowKit/wagmi runtime config — the hook only needs the map.
vi.mock("./wagmi", () => ({
  BRIDGE_SEND_CHAIN_IDS: { "137": 137, "8453": 8453, "42161": 42161, "1": 1, "10": 10, "56": 56 },
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: state.address }),
  // Balances aligned to evmTokensForChain's order (native first, then priority).
  // chainId now rides on each contract entry, not the top-level config.
  useReadContracts: (cfg: {
    contracts?: { chainId?: number }[];
    query?: { enabled?: boolean };
  }) => {
    if (!cfg.query?.enabled) return { data: undefined, isLoading: false };
    const chainId = cfg.contracts?.[0]?.chainId ?? 0;
    const byChain: Record<number, { status: string; result: bigint }[]> = {
      137: [
        { status: "success", result: 0n }, // POL (native)
        { status: "success", result: 0n }, // USDC
        { status: "success", result: 5_000000n }, // USDC.e → 5
      ],
      8453: [
        { status: "success", result: 1_000000000000000000n }, // ETH → 1
        { status: "success", result: 0n }, // USDC
      ],
    };
    return { data: byChain[chainId] ?? [], isLoading: false };
  },
}));

import { useWalletHoldings } from "./use-wallet-holdings";
import type { FundsAsset } from "./types";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const asset = (o: {
  chainId: string;
  chainName: string;
  symbol: string;
  address: string;
  decimals?: number;
}): FundsAsset => ({
  id: `${o.chainId}:${o.address.toLowerCase()}`,
  chainId: o.chainId,
  chainName: o.chainName,
  addressType: "evm",
  minCheckoutUsd: 2,
  token: { name: o.symbol, symbol: o.symbol, address: o.address, decimals: o.decimals ?? 6 },
});

const ASSETS: FundsAsset[] = [
  asset({ chainId: "137", chainName: "Polygon", symbol: "POL", address: NATIVE, decimals: 18 }),
  asset({ chainId: "137", chainName: "Polygon", symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" }),
  asset({ chainId: "137", chainName: "Polygon", symbol: "USDC.e", address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" }),
  asset({ chainId: "8453", chainName: "Base", symbol: "ETH", address: NATIVE, decimals: 18 }),
  asset({ chainId: "8453", chainName: "Base", symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }),
];

beforeEach(() => {
  state.address = "0x1111111111111111111111111111111111111111";
});

describe("useWalletHoldings", () => {
  it("flattens + sorts connected-wallet balances by USD, keeping the held variant", () => {
    const { result } = renderHook(() => useWalletHoldings(ASSETS, { ETH: 3000, POL: 0.5 }));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.scannedAnyToken).toBe(true);
    const h = result.current.holdings;
    expect(h).toHaveLength(2); // zero balances dropped
    expect(h[0]).toMatchObject({ group: "ETH", chainId: "8453", usd: 3000 });
    expect(h[1]).toMatchObject({ group: "USDC", chainId: "137", usd: 5, symbol: "USDC.e" });
  });

  it("returns nothing when no wallet is connected", () => {
    state.address = undefined;
    const { result } = renderHook(() => useWalletHoldings(ASSETS, {}));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.holdings).toEqual([]);
  });
});
