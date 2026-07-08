"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { useSession } from "@/lib/auth";
import { useFeatureFlags, useProvisionTradingWallet } from "@/lib/queries";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#2a36ff",
            accentColorForeground: "#ffffff",
            borderRadius: "medium",
            fontStack: "system",
          })}
        >
          <AutoProvisionTradingWallet />
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function AutoProvisionTradingWallet() {
  const session = useSession();
  const flags = useFeatureFlags();
  const provision = useProvisionTradingWallet();
  const { mutate, isError, isPending, isSuccess } = provision;

  useEffect(() => {
    if (!session.data?.address || !flags.data?.privySigning || isPending) return;
    if (isSuccess || isError) return;
    mutate();
  }, [flags.data?.privySigning, isError, isPending, isSuccess, mutate, session.data?.address]);

  return null;
}
