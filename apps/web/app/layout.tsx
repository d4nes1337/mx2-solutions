import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { TerminalDock } from "@/components/terminal/TerminalDock";
import { THEME_INIT_SCRIPT } from "@/lib/theme-constants";

export const metadata: Metadata = {
  title: "arima — smart orders for Polymarket",
  description:
    "arima · build smart Polymarket orders visually. No code. No spreadsheets. Just logic.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Applies the persisted theme to <html> before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-4 sm:py-5">
            {children}
          </main>
          <footer className="mx-auto max-w-[1600px] px-3 pb-8 pt-4 text-[11px] leading-relaxed text-faint sm:px-4">
            <div className="border-t border-border pt-4">
              <span className="font-semibold text-muted">arima</span> — build smart Polymarket
              orders visually. Market data from Polymarket Gamma / Data / CLOB APIs. Not investment
              advice.
            </div>
          </footer>
          <TerminalDock />
        </Providers>
      </body>
    </html>
  );
}
