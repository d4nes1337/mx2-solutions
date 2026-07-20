"use client";

/**
 * Connected-wallet holdings across the EVM chains we can read — the data behind
 * the Polymarket-style "here's what you hold, pick one to deposit" list.
 *
 * Hooks can't run in a loop, so this issues exactly six fixed `useReadContracts`
 * calls (one per chain in `BALANCE_CHAIN_IDS`, unconditional + fixed order).
 * viem collapses each call's `balanceOf`/`getEthBalance` batch into a single
 * Multicall3 `aggregate3` RPC, so the whole scan is six RPC round-trips. All
 * pure shaping/valuation lives in `funds-holdings.ts`.
 */
import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { BRIDGE_SEND_CHAIN_IDS } from "./wagmi";
import {
  BALANCE_CHAIN_IDS,
  buildHoldings,
  evmTokensForChain,
  scanContracts,
  type ChainScan,
  type WalletHolding,
} from "./funds-holdings";
import type { FundsAsset } from "./types";

export interface WalletHoldingsResult {
  holdings: WalletHolding[];
  isLoading: boolean;
  isConnected: boolean;
  /** ≥1 EVM token existed to scan — separates "catalog not loaded" from
   * "you hold nothing readable" for the empty-state copy. */
  scannedAnyToken: boolean;
}

/** Coerce one allow-failure multicall entry to a balance (null on failure). */
const toBalance = (entry: unknown): bigint | null => {
  const result = (entry as { status?: string; result?: unknown } | undefined)?.result;
  return typeof result === "bigint" ? result : null;
};

export function useWalletHoldings(
  assets: FundsAsset[],
  prices: Record<string, number>,
): WalletHoldingsResult {
  const { address } = useAccount();
  const holder = address as `0x${string}` | undefined;
  const on = !!holder;

  const tokensByChain = useMemo(
    () => BALANCE_CHAIN_IDS.map((id) => evmTokensForChain(assets, id)),
    [assets],
  );
  const contractsByChain = useMemo(
    () =>
      tokensByChain.map((tokens, i) =>
        holder ? scanContracts(tokens, holder, BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[i]!]!) : [],
      ),
    [tokensByChain, holder],
  );

  const c0 = contractsByChain[0] ?? [];
  const c1 = contractsByChain[1] ?? [];
  const c2 = contractsByChain[2] ?? [];
  const c3 = contractsByChain[3] ?? [];
  const c4 = contractsByChain[4] ?? [];
  const c5 = contractsByChain[5] ?? [];

  // One fixed useReadContracts per chain — index order matches BALANCE_CHAIN_IDS.
  // chainId rides on each contract (useReadContracts has no top-level chainId).
  const r0 = useReadContracts({
    allowFailure: true,
    contracts: c0,
    query: { enabled: on && c0.length > 0, staleTime: 30_000 },
  });
  const r1 = useReadContracts({
    allowFailure: true,
    contracts: c1,
    query: { enabled: on && c1.length > 0, staleTime: 30_000 },
  });
  const r2 = useReadContracts({
    allowFailure: true,
    contracts: c2,
    query: { enabled: on && c2.length > 0, staleTime: 30_000 },
  });
  const r3 = useReadContracts({
    allowFailure: true,
    contracts: c3,
    query: { enabled: on && c3.length > 0, staleTime: 30_000 },
  });
  const r4 = useReadContracts({
    allowFailure: true,
    contracts: c4,
    query: { enabled: on && c4.length > 0, staleTime: 30_000 },
  });
  const r5 = useReadContracts({
    allowFailure: true,
    contracts: c5,
    query: { enabled: on && c5.length > 0, staleTime: 30_000 },
  });

  const datas = [r0.data, r1.data, r2.data, r3.data, r4.data, r5.data];

  const holdings = useMemo(() => {
    if (!on) return [];
    const scans: ChainScan[] = BALANCE_CHAIN_IDS.map((id, i) => ({
      chainId: id,
      tokens: tokensByChain[i] ?? [],
      balances: (datas[i] ?? []).map(toBalance),
    }));
    return buildHoldings(scans, prices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, tokensByChain, prices, r0.data, r1.data, r2.data, r3.data, r4.data, r5.data]);

  const results = [r0, r1, r2, r3, r4, r5];
  const isLoading = on && results.some((r, i) => (contractsByChain[i]?.length ?? 0) > 0 && r.isLoading);
  const scannedAnyToken = tokensByChain.some((t) => t.length > 0);

  return { holdings, isLoading, isConnected: on, scannedAnyToken };
}
