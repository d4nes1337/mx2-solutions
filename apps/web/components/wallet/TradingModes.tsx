"use client";

import { Check, Wallet, Zap } from "lucide-react";
import { cn } from "@/components/ui";
import type { TradingAccount } from "@/lib/types";

/** The two ways to trade on arima, in user language. */
export function TradingModeCards() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-border bg-surface p-4 shadow-panel">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-3 text-fg">
            <Wallet size={17} aria-hidden />
          </span>
          <div>
            <div className="text-[15px] font-semibold text-fg">Your wallet</div>
            <div className="text-[12px] text-muted">Sign each trade yourself</div>
          </div>
        </div>
        <ul className="mt-3 space-y-1.5 text-[13px] text-muted">
          <li>Connect the wallet you already use on Polymarket.</li>
          <li>Every order is confirmed in your wallet — you keep full control.</li>
          <li>Best for manual trading and “ask to sign” Smart Orders.</li>
        </ul>
      </div>

      <div className="rounded-xl border border-brand/40 bg-surface p-4 shadow-panel">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-soft text-accent">
            <Zap size={17} aria-hidden />
          </span>
          <div>
            <div className="text-[15px] font-semibold text-fg">Arima trading wallet</div>
            <div className="text-[12px] text-muted">No-popup trading, built for Smart Orders</div>
          </div>
        </div>
        <ul className="mt-3 space-y-1.5 text-[13px] text-muted">
          <li>A separate wallet you top up with only what you want to trade.</li>
          <li>Smart Orders can execute without interrupting you to sign.</li>
          <li>We never ask for your seed phrase or your main wallet’s keys.</li>
        </ul>
      </div>
    </div>
  );
}

const STEPS = ["Create", "Top up", "Activate", "Trade"] as const;

/** Maps the internal trading-account state onto the user-facing readiness steps. */
export function stepForAccount(account: TradingAccount | null): number {
  if (!account || account.status === "needs_deposit_wallet") return 0;
  if (account.status === "needs_funding") return 1;
  if (account.status === "needs_delegation" || account.status === "needs_credentials") return 2;
  if (account.status === "ready") return 3;
  return 0;
}

export function WalletStepper({ account }: { account: TradingAccount | null }) {
  const current = stepForAccount(account);
  const done = account?.status === "ready";
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Trading wallet readiness">
      {STEPS.map((label, i) => {
        const state = done || i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium",
                state === "done" && "border-pos/30 bg-pos/10 text-pos",
                state === "current" && "border-brand/50 bg-brand-soft text-accent",
                state === "todo" && "border-border bg-surface-2 text-faint",
              )}
            >
              {state === "done" ? <Check size={12} aria-hidden /> : null}
              {label}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px w-4 bg-border-strong" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
