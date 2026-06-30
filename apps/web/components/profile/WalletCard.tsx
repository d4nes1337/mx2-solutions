"use client";

import { useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Loader2, Wallet, Zap } from "lucide-react";
import {
  useActivateDepositWallet,
  useBootstrapAllowances,
  useSetPrimaryTradingAccount,
  useTradingWallet,
} from "@/lib/queries";
import type { TradingAccount } from "@/lib/types";
import { Badge, Button, cn } from "@/components/ui";
import { TopUpSheet } from "./TopUpSheet";

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-0.5 text-muted transition-colors hover:text-fg"
      title="Copy address"
    >
      {copied ? <Check size={12} className="text-pos" /> : <Copy size={12} />}
    </button>
  );
}

function StatusBadge({ account }: { account: TradingAccount }) {
  if (account.signingMode === "browser") {
    if (account.credentialsReady) {
      return <Badge tone="pos" dot>Ready</Badge>;
    }
    return <Badge tone="warn" dot>Needs credentials</Badge>;
  }
  // server-side (Privy) wallet
  const s = account.status;
  if (s === "needs_deposit_wallet") return <Badge tone="warn" dot>Needs activation</Badge>;
  if (s === "needs_funding") return <Badge tone="warn" dot>Needs funding</Badge>;
  if (s === "needs_delegation") return <Badge tone="warn" dot>Needs delegation</Badge>;
  if (s === "ready") return <Badge tone="pos" dot>Ready</Badge>;
  return <Badge tone="neutral">{s}</Badge>;
}

function ModeChip({ account }: { account: TradingAccount }) {
  if (account.signingMode === "browser")
    return <Badge tone="neutral">Browser signing</Badge>;
  return <Badge tone="accent">Server signing</Badge>;
}

interface WalletCardProps {
  account: TradingAccount;
  onSetupCredentials: (account: TradingAccount) => void;
}

export function WalletCard({ account, onSetupCredentials }: WalletCardProps) {
  const setPrimary = useSetPrimaryTradingAccount();
  const activateDeposit = useActivateDepositWallet();
  const bootstrap = useBootstrapAllowances();
  const walletStatus = useTradingWallet(true);

  const [topUpOpen, setTopUpOpen] = useState(false);

  const depositWalletAddress =
    account.depositWalletAddress ??
    walletStatus.data?.depositWalletAddress ??
    null;

  const isPrivy = account.kind === "internal_privy";
  const isBusy =
    setPrimary.isPending || activateDeposit.isPending || bootstrap.isPending;

  const handleActivate = () => {
    activateDeposit.mutate(undefined, {
      onError: (e) => {
        console.error("Activation failed", e);
      },
    });
  };

  const handleBootstrap = () => {
    bootstrap.mutate(undefined, {
      onError: (e) => {
        console.error("Bootstrap failed", e);
      },
    });
  };

  const activateError =
    activateDeposit.isError
      ? (activateDeposit.error as Error)?.message ?? "Activation failed"
      : null;
  const bootstrapError =
    bootstrap.isError
      ? (bootstrap.error as Error)?.message ?? "Bootstrap failed"
      : null;

  return (
    <>
      <div
        className={cn(
          "rounded-lg border p-4 transition-colors",
          account.isPrimary
            ? "border-accent/40 bg-accent/5"
            : "border-border bg-surface hover:border-border-strong",
        )}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            {isPrivy ? (
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/15">
                <Zap size={14} className="text-accent" />
              </div>
            ) : (
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand/15">
                <Wallet size={14} className="text-accent" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-fg">{account.label}</span>
                {account.isPrimary && (
                  <Badge tone="accent" className="gap-1">
                    <Check size={10} />
                    primary
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                <span className="font-mono">{shortAddress(account.signerAddress)}</span>
                <CopyButton text={account.signerAddress} />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge account={account} />
            <ModeChip account={account} />
          </div>
        </div>

        {/* Deposit wallet address (Privy) */}
        {isPrivy && depositWalletAddress && (
          <div className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">Deposit wallet (Polygon)</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="font-mono text-[12px] text-fg">{shortAddress(depositWalletAddress)}</span>
              <CopyButton text={depositWalletAddress} />
              <a
                href={`https://polygonscan.com/address/${depositWalletAddress}`}
                target="_blank"
                rel="noreferrer"
                className="text-muted hover:text-fg"
                title="View on Polygonscan"
              >
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        )}

        {/* Action row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Set primary */}
          {!account.isPrimary && (
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => setPrimary.mutate(account.id)}
            >
              {setPrimary.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Make primary
            </Button>
          )}

          {/* Browser wallet: setup credentials */}
          {account.signingMode === "browser" && !account.credentialsReady && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onSetupCredentials(account)}
            >
              <ChevronRight size={13} />
              Setup credentials
            </Button>
          )}

          {/* Privy: activate deposit wallet */}
          {isPrivy && account.nextAction === "activate_deposit_wallet" && (
            <Button
              size="sm"
              variant="primary"
              disabled={isBusy}
              onClick={handleActivate}
            >
              {activateDeposit.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Zap size={12} />
              )}
              Activate trading account
            </Button>
          )}

          {/* Privy: top up */}
          {isPrivy && account.nextAction === "top_up" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setTopUpOpen(true)}
            >
              Top up USDC
            </Button>
          )}

          {/* Privy: bootstrap (after funding, if status still needs_funding) */}
          {isPrivy && account.status === "needs_funding" && depositWalletAddress && (
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={handleBootstrap}
            >
              {bootstrap.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Check & activate trading
            </Button>
          )}
        </div>

        {/* Errors */}
        {activateError && (
          <p className="mt-2 text-[12px] text-neg">{activateError}</p>
        )}
        {bootstrapError && (
          <p className="mt-2 text-[12px] text-neg">{bootstrapError}</p>
        )}
      </div>

      {isPrivy && depositWalletAddress && (
        <TopUpSheet
          open={topUpOpen}
          onClose={() => setTopUpOpen(false)}
          depositWalletAddress={depositWalletAddress}
        />
      )}
    </>
  );
}
