"use client";

/**
 * Connected-wallet balances of a chosen token group across the EVM chains the
 * app can read, so the deposit picker can surface "you have funds here" like
 * Polymarket. Non-EVM families (Solana/Bitcoin/Tron) can't be read from an EVM
 * wallet and are simply absent from the map.
 *
 * Hooks can't be called in a loop, so we resolve the per-chain token first
 * (pure) and issue one fixed `useBalance` per supported chain, gated by `enabled`.
 */
import { useAccount, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { assetForSelection, isNativePlaceholder } from "./funds-assets";
import { BRIDGE_SEND_CHAIN_IDS } from "./wagmi";
import type { FundsAsset } from "./types";

/** EVM chains whose connected-wallet balances we can read (display order). */
export const BALANCE_CHAIN_IDS = ["1", "8453", "42161", "137", "10", "56"] as const;

export interface ChainBalance {
  /** Human amount, e.g. 12.34. */
  amount: number;
  /** Compact display string, e.g. "12.34". */
  label: string;
  hasBalance: boolean;
}

const resolve = (assets: FundsAsset[], group: string, chainId: string) => {
  const asset = assetForSelection(assets, group, chainId);
  if (!asset) return { token: undefined, decimals: 18, present: false };
  const native = isNativePlaceholder(asset.token.address);
  return {
    token: native ? undefined : (asset.token.address as `0x${string}`),
    decimals: asset.token.decimals,
    present: true,
  };
};

const fmt = (value: bigint, decimals: number): ChainBalance => {
  const amount = Number(formatUnits(value, decimals));
  return {
    amount,
    label: amount >= 1 ? amount.toFixed(2) : amount > 0 ? amount.toFixed(4) : "0",
    hasBalance: value > 0n,
  };
};

/** Map of chainId → connected-wallet balance of the resolved token, when readable. */
export function useChainTokenBalances(
  assets: FundsAsset[],
  group: string,
): Record<string, ChainBalance> {
  const { address } = useAccount();
  const on = !!address;

  const r = BALANCE_CHAIN_IDS.map((id) => resolve(assets, group, id));
  // One fixed useBalance per supported chain — index order matches BALANCE_CHAIN_IDS.
  const b0 = useBalance({
    address,
    token: r[0]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[0]],
    query: { enabled: on && r[0]!.present },
  });
  const b1 = useBalance({
    address,
    token: r[1]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[1]],
    query: { enabled: on && r[1]!.present },
  });
  const b2 = useBalance({
    address,
    token: r[2]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[2]],
    query: { enabled: on && r[2]!.present },
  });
  const b3 = useBalance({
    address,
    token: r[3]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[3]],
    query: { enabled: on && r[3]!.present },
  });
  const b4 = useBalance({
    address,
    token: r[4]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[4]],
    query: { enabled: on && r[4]!.present },
  });
  const b5 = useBalance({
    address,
    token: r[5]!.token,
    chainId: BRIDGE_SEND_CHAIN_IDS[BALANCE_CHAIN_IDS[5]],
    query: { enabled: on && r[5]!.present },
  });

  const results = [b0, b1, b2, b3, b4, b5];
  const out: Record<string, ChainBalance> = {};
  BALANCE_CHAIN_IDS.forEach((id, i) => {
    const data = results[i]!.data;
    if (r[i]!.present && data) out[id] = fmt(data.value, data.decimals);
  });
  return out;
}
