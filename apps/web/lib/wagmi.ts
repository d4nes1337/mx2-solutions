"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { polygon } from "wagmi/chains";
import { http } from "wagmi";

// Polygon (chainId 137) only — matches the backend's EIP-712 login domain and
// ADR-0002 (Deposit Wallet on Polygon). MetaMask (injected) works with the
// placeholder projectId; WalletConnect needs a real id from cloud.walletconnect.com.
export const wagmiConfig = getDefaultConfig({
  appName: "MX2 Terminal",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "MX2_LOCAL_DEV_PLACEHOLDER",
  chains: [polygon],
  transports: {
    [polygon.id]: http(process.env.NEXT_PUBLIC_POLYGON_RPC_URL || undefined),
  },
  ssr: true,
});
