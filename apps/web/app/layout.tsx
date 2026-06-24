import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "MX2 Terminal",
  description: "Non-custodial Polymarket terminal — closed beta MVP",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>
          <Header />
          <main className="mx-auto max-w-[1600px] px-3 py-4">{children}</main>
          <footer className="mx-auto max-w-[1600px] px-3 py-6 text-xs text-muted">
            MVP — read-only feed, portfolio &amp; preview-only trading. Data from Polymarket Gamma /
            Data / CLOB APIs.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
