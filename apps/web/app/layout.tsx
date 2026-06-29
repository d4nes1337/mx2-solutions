import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "arima — prediction market terminal",
  description: "arima · non-custodial Polymarket trading terminal — closed beta",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-4 sm:py-5">
            {children}
          </main>
          <footer className="mx-auto max-w-[1600px] px-3 pb-8 pt-4 text-[11px] leading-relaxed text-faint sm:px-4">
            <div className="border-t border-border pt-4">
              <span className="font-semibold text-muted">arima</span> — read-only feed, portfolio
              &amp; preview-only trading. Market data from Polymarket Gamma / Data / CLOB APIs. Not
              investment advice.
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
