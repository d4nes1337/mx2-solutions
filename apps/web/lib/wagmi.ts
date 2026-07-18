"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arbitrum, base, bsc, mainnet, optimism, polygon } from "wagmi/chains";
import { http } from "wagmi";

// Polygon (chainId 137) is the home chain — the backend's EIP-712 login domain
// and ADR-0002 (Deposit Wallet on Polygon) are pinned to it. The other chains
// exist ONLY for bridge-funding sends ("send USDC from your wallet on Base"):
// sign-in and all trading flows stay on 137. MetaMask (injected) works with
// the placeholder projectId; WalletConnect needs a real id from
// cloud.walletconnect.com.
export const wagmiConfig = getDefaultConfig({
  appName: "MX2 Terminal",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "MX2_LOCAL_DEV_PLACEHOLDER",
  chains: [polygon, base, arbitrum, mainnet, optimism, bsc],
  transports: {
    [polygon.id]: http(process.env.NEXT_PUBLIC_POLYGON_RPC_URL || undefined),
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || undefined),
    [arbitrum.id]: http(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL || undefined),
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL || undefined),
    [optimism.id]: http(),
    [bsc.id]: http(),
  },
  ssr: true,
});

/** Chains the in-app "send from connected wallet" flow can switch to (EVM only). */
export const BRIDGE_SEND_CHAIN_IDS: Record<string, number> = {
  "137": polygon.id,
  "8453": base.id,
  "42161": arbitrum.id,
  "1": mainnet.id,
  "10": optimism.id,
  "56": bsc.id,
};
