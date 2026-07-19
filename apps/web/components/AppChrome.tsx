"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Header } from "@/components/Header";
import { TerminalDock } from "@/components/terminal/TerminalDock";
import { FundsHost } from "@/components/profile/funds/FundsHost";

/**
 * Global chrome switch. Routes under /m/* are the mobile companion surface
 * (opened from Telegram notifications, possibly inside the Telegram webview):
 * they render bare — no header/nav/dock/funds host — because a restricted
 * sign-link session cannot use any of those surfaces anyway.
 */
export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const minimal = pathname === "/m" || pathname?.startsWith("/m/");

  if (minimal) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    );
  }

  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-4 sm:py-5">{children}</main>
      <footer className="mx-auto max-w-[1600px] px-3 pb-8 pt-4 text-[11px] leading-relaxed text-faint sm:px-4">
        <div className="border-t border-border pt-4">
          <span className="font-semibold text-muted">arima</span> — build smart Polymarket orders
          visually. Market data from Polymarket Gamma / Data / CLOB APIs. Not investment advice.
        </div>
      </footer>
      <TerminalDock />
      <FundsHost />
    </>
  );
}
