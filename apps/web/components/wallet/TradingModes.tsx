"use client";

import { useState } from "react";
import { Check, Coins, Loader2, ShieldCheck, Wallet, Zap } from "lucide-react";
import {
  useActivateDepositWallet,
  useBootstrapAllowances,
  useProvisionTradingWallet,
} from "@/lib/queries";
import type { TradingAccount } from "@/lib/types";
import { Badge, Button, ErrorNote, cn } from "@/components/ui";
import { FundsSheet } from "@/components/profile/FundsSheet";

/** Secondary explanation of the two signing modes, in user language. */
export function TradingModeCards() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Trading modes">
      <div className="rounded-md border border-border bg-surface p-4">
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

      <div className="rounded-md border border-brand/40 bg-surface p-4">
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

const STEPS = ["Create", "Activate", "Fund", "Authorize", "Trade"] as const;

/** Maps the internal trading-account state onto the user-facing readiness steps. */
export function stepForAccount(account: TradingAccount | null): number {
  if (!account) return 0;
  if (account.status === "needs_deposit_wallet") return 1;
  if (account.status === "needs_funding") return 2;
  if (account.status === "needs_delegation" || account.status === "needs_credentials") return 3;
  if (account.status === "ready") return 4;
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

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function nextCopy(account: TradingAccount | null, privyEnabled: boolean) {
  if (!privyEnabled) {
    return {
      title: "Connected-wallet trading is available",
      body: "No-popup trading wallets are not enabled on this build yet.",
      button: null,
    };
  }
  if (!account) {
    return {
      title: "Create your trading account",
      body: "We create a separate Arima trading wallet. You fund it only with the amount you want to trade.",
      button: "Enable trading",
    };
  }
  if (account.status === "needs_deposit_wallet") {
    return {
      title: "Activate the deposit wallet",
      body: "This deploys the Polymarket deposit wallet that will hold your pUSD trading balance.",
      button: "Activate deposit wallet",
    };
  }
  if (account.status === "needs_funding") {
    return {
      title: "Add funds",
      body: "Top up with USDC, USDT, ETH, SOL, BTC and 200+ other assets from any major chain.",
      button: "Add funds",
    };
  }
  if (account.status === "needs_delegation" || account.status === "needs_credentials") {
    return {
      title: "Authorize trading",
      body: "Finish the trading permissions so orders can be prepared without extra wallet popups.",
      button: "Check funds and activate",
    };
  }
  if (account.status === "ready") {
    return {
      title: "Ready to trade",
      body: "Your Arima trading wallet can submit prepared orders using the funds in the deposit wallet.",
      button: "Add funds",
    };
  }
  return {
    title: "Review wallet status",
    body: "This account needs attention before no-popup trading is available.",
    button: null,
  };
}

export function TradingSetupPanel({
  account,
  privyEnabled,
}: {
  account: TradingAccount | null;
  privyEnabled: boolean;
}) {
  const provisionWallet = useProvisionTradingWallet();
  const activateDeposit = useActivateDepositWallet();
  const bootstrap = useBootstrapAllowances();
  const [fundsOpen, setFundsOpen] = useState(false);
  const copy = nextCopy(account, privyEnabled);

  const busy = provisionWallet.isPending || activateDeposit.isPending || bootstrap.isPending;
  const canOpenFunds = Boolean(account?.depositWalletAddress);
  const mainError =
    (provisionWallet.error as Error | null)?.message ??
    (activateDeposit.error as Error | null)?.message ??
    (bootstrap.error as Error | null)?.message ??
    null;

  const runPrimary = () => {
    if (!privyEnabled) return;
    if (!account) {
      provisionWallet.mutate();
      return;
    }
    if (account.status === "needs_deposit_wallet") {
      activateDeposit.mutate();
      return;
    }
    if (account.status === "needs_funding" || account.status === "ready") {
      setFundsOpen(true);
      return;
    }
    if (account.status === "needs_delegation" || account.status === "needs_credentials") {
      bootstrap.mutate();
    }
  };

  return (
    <>
      <section className="rounded-md border border-border bg-surface p-4 shadow-panel">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={account?.status === "ready" ? "pos" : "accent"} dot>
                {account?.status === "ready" ? "Trading enabled" : "Trading setup"}
              </Badge>
              {account?.depositWalletAddress ? (
                <span className="font-mono text-[11px] text-muted">
                  deposit {shortAddress(account.depositWalletAddress)}
                </span>
              ) : null}
            </div>
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-fg">{copy.title}</h2>
              <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">{copy.body}</p>
            </div>
            <WalletStepper account={account} />
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            {copy.button ? (
              <Button
                type="button"
                variant={account?.status === "ready" ? "outline" : "primary"}
                disabled={busy || (copy.button === "Add funds" && !canOpenFunds)}
                onClick={runPrimary}
              >
                {busy ? (
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                ) : (
                  <Zap size={13} />
                )}
                {copy.button}
              </Button>
            ) : null}
            {account?.status === "needs_funding" && canOpenFunds ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={bootstrap.isPending}
                onClick={() => bootstrap.mutate()}
              >
                <ShieldCheck size={12} aria-hidden />
                Check funds
              </Button>
            ) : null}
          </div>
        </div>

        {mainError ? (
          <div className="mt-3">
            <ErrorNote message={mainError} />
          </div>
        ) : null}

        <div className="mt-4 grid gap-2 border-t border-border pt-3 text-[12px] text-muted sm:grid-cols-3">
          <div className="flex items-start gap-2">
            <Wallet size={14} className="mt-0.5 text-accent" aria-hidden />
            <span>Keep your main wallet separate from trading funds.</span>
          </div>
          <div className="flex items-start gap-2">
            <Coins size={14} className="mt-0.5 text-accent" aria-hidden />
            <span>Spendable balance is pUSD on Polygon.</span>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck size={14} className="mt-0.5 text-accent" aria-hidden />
            <span>Withdrawals stay locked to your login wallet.</span>
          </div>
        </div>
      </section>

      {account?.depositWalletAddress ? (
        <FundsSheet
          open={fundsOpen}
          onClose={() => setFundsOpen(false)}
          depositWalletAddress={account.depositWalletAddress}
          signerAddress={account.signerAddress}
        />
      ) : null}
    </>
  );
}
