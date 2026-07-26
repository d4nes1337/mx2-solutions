"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { ThemeProvider, useTheme, type Theme } from "@/lib/theme";
import { MotionProvider } from "@/components/motion/MotionProvider";

// RainbowKit takes a JS theme object, not CSS vars — keep it in step with the
// app theme. Paper is a light theme with the same brand accent.
const RK_THEMES: Record<Theme, ReturnType<typeof lightTheme>> = {
  light: lightTheme({
    accentColor: "#2a36ff",
    accentColorForeground: "#ffffff",
    borderRadius: "medium",
    fontStack: "system",
  }),
  paper: lightTheme({
    accentColor: "#2a36ff",
    accentColorForeground: "#ffffff",
    borderRadius: "medium",
    fontStack: "system",
  }),
  dark: darkTheme({
    accentColor: "#4b56ff",
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
  const { theme } = useTheme();
  return <RainbowKitProvider theme={RK_THEMES[theme]}>{children}</RainbowKitProvider>;
}
