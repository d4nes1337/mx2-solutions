"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { ThemeProvider, useTheme, type ResolvedTheme } from "@/lib/theme";
import { MotionProvider } from "@/components/motion/MotionProvider";

// RainbowKit takes a JS theme object, not CSS vars — keep it in step with the
// resolved app palette (accents mirror --brand per theme in globals.css).
const RK_THEMES: Record<ResolvedTheme, ReturnType<typeof lightTheme>> = {
  light: lightTheme({
    accentColor: "#2a36ff",
    accentColorForeground: "#ffffff",
    borderRadius: "medium",
    fontStack: "system",
  }),
  dark: darkTheme({
    accentColor: "#4a55ff",
    accentColorForeground: "#ffffff",
    borderRadius: "medium",
    fontStack: "system",
  }),
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <ThemedRainbowKit>
            <MotionProvider>{children}</MotionProvider>
          </ThemedRainbowKit>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}

function ThemedRainbowKit({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return <RainbowKitProvider theme={RK_THEMES[resolvedTheme]}>{children}</RainbowKitProvider>;
}
