"use client";

import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Trash2,
  Wallet,
  Zap,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useActivateDepositWallet,
  useArchiveTradingAccount,
  useBootstrapAllowances,
  useFeatureFlags,
  useSetPrimaryTradingAccount,
  useTradingWallet,
} from "@/lib/queries";
import type { TradingAccount } from "@/lib/types";
import { Badge, Button, cn } from "@/components/ui";
import { useFundsUi } from "@/lib/funds-ui";

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
      return (
        <Badge tone="pos" dot>
          Ready
        </Badge>
      );
    }
    return (
      <Badge tone="warn" dot>
        Needs credentials
      </Badge>
    );
  }
  // server-side (Privy) wallet
  const s = account.status;
  if (s === "needs_deposit_wallet")
    return (
      <Badge tone="warn" dot>
        Needs activation
      </Badge>
    );
  if (s === "needs_funding")
    return (
      <Badge tone="warn" dot>
        Needs funding
      </Badge>
    );
  // Funded but never authorized: deposits/withdrawals work, orders can't go
  // out — say so instead of a reassuring "Funded" (owner beta finding).
  if (account.nextAction === "bootstrap_allowances")
    return (
      <Badge
        tone="warn"
        dot
        title="Press “Authorize trading” to grant the one-time exchange approvals"
      >
        Needs authorization
      </Badge>
    );
  if (s === "needs_delegation" || s === "needs_credentials")
    return (
      <Badge tone="pos" dot>
        Funded
      </Badge>
    );
  if (s === "ready")
    return (
      <Badge tone="pos" dot>
        Ready
      </Badge>
    );
  return <Badge tone="neutral">{s}</Badge>;
}

function ModeChip({ account }: { account: TradingAccount }) {
  if (account.signingMode === "browser") return <Badge tone="neutral">Browser signing</Badge>;
  return <Badge tone="accent">Server signing</Badge>;
}

interface WalletCardProps {
  account: TradingAccount;
  /** The address the user is currently signed in with — cannot be archived. */
  loginAddress: string;
  onSetupCredentials: (account: TradingAccount) => void;
  /** Open the top-up sheet immediately (deep link /wallet?topup=1). */
  autoOpenTopUp?: boolean;
}

export function WalletCard({
  account,
  loginAddress,
  onSetupCredentials,
  autoOpenTopUp = false,
}: WalletCardProps) {
  const setPrimary = useSetPrimaryTradingAccount();
  const activateDeposit = useActivateDepositWallet();
  const archive = useArchiveTradingAccount();
  const bootstrap = useBootstrapAllowances();
  const flags = useFeatureFlags();
  const walletStatus = useTradingWallet(true);
  const qc = useQueryClient();

  const openSheet = useFundsUi((s) => s.openSheet);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Deep link /wallet?topup=1 → open the global Funds sheet on Add funds.
  useEffect(() => {
    if (autoOpenTopUp) openSheet("topup");
  }, [autoOpenTopUp, openSheet]);

  const depositWalletAddress =
    account.depositWalletAddress ?? walletStatus.data?.depositWalletAddress ?? null;

  const isPrivy = account.kind === "internal_privy";
  const isLoginWallet = account.signerAddress.toLowerCase() === loginAddress.toLowerCase();
  const isBusy = setPrimary.isPending || activateDeposit.isPending || archive.isPending;

  const handleActivate = () => {
    activateDeposit.mutate(undefined, {
      onError: (e) => {
        console.error("Activation failed", e);
      },
    });
  };

  // Re-read the account — status reconciles against the on-chain pUSD balance
  // server-side, so a just-arrived deposit clears the "needs funding" prompt.
  const handleCheckFunds = () => {
    void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
    void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
    void qc.invalidateQueries({ queryKey: ["trading-wallet-balance"] });
  };

  const activateError = activateDeposit.isError
    ? ((activateDeposit.error as Error)?.message ?? "Activation failed")
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
            <div className="text-[10px] uppercase tracking-wide text-muted">
              Deposit wallet (pUSD on Polygon)
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="font-mono text-[12px] text-fg">
                {shortAddress(depositWalletAddress)}
              </span>
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
        <div className="mt-3 flex flex-wrap items-center gap-2 justify-between">
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
            <Button size="sm" variant="outline" onClick={() => onSetupCredentials(account)}>
              <ChevronRight size={13} />
              Setup credentials
            </Button>
          )}

          {/* Privy: activate deposit wallet */}
          {isPrivy && account.nextAction === "activate_deposit_wallet" && (
            <Button size="sm" variant="primary" disabled={isBusy} onClick={handleActivate}>
              {activateDeposit.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Zap size={12} />
              )}
              Activate trading account
            </Button>
          )}

          {/* Privy: authorize trading — the one-time exchange allowances the
              deposit wallet needs before ANY order can go out. This action had
              no button at all before (owner beta finding). */}
          {isPrivy && account.nextAction === "bootstrap_allowances" && depositWalletAddress && (
            <Button
              size="sm"
              variant="primary"
              disabled={bootstrap.isPending}
              title="Grants the one-time Polymarket exchange approvals from your trading wallet (gasless)."
              onClick={() => bootstrap.mutate()}
            >
              {bootstrap.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Zap size={12} />
              )}
              {bootstrap.isPending ? "Authorizing…" : "Authorize trading"}
            </Button>
          )}

          {/* Privy: add funds — always reachable once a deposit wallet exists;
              promoted to the primary action when funding is the next step. */}
          {isPrivy && depositWalletAddress && (
            <Button
              size="sm"
              variant={account.nextAction === "top_up" ? "primary" : "ghost"}
              onClick={() => openSheet("topup")}
            >
              Add funds
            </Button>
          )}

          {/* Privy: withdraw — the wallet page previously had NO withdraw path
              at all; the sheet's withdraw tab was only reachable by hand. */}
          {isPrivy && depositWalletAddress && flags.data?.walletWithdraw && (
            <Button size="sm" variant="ghost" onClick={() => openSheet("withdraw")}>
              Withdraw
            </Button>
          )}

          {/* Privy: re-check for an arrived deposit (status reconciles on read) */}
          {isPrivy && account.status === "needs_funding" && depositWalletAddress && (
            <Button size="sm" variant="outline" disabled={isBusy} onClick={handleCheckFunds}>
              Check funds
            </Button>
          )}
          {/* Spacer so remove sits on the right */}
          <span className="flex-1" />
          {/* Remove wallet (blocked for the login wallet) */}
          {!isLoginWallet && !confirmDelete && (
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => setConfirmDelete(true)}
              className="text-muted hover:text-neg"
            >
              <Trash2 size={12} />
              Remove
            </Button>
          )}
          {!isLoginWallet && confirmDelete && (
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] text-neg">Remove this wallet?</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={archive.isPending}
                onClick={() => {
                  archive.mutate(account.id);
                  setConfirmDelete(false);
                }}
                className="text-neg hover:text-neg"
              >
                {archive.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={archive.isPending}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>

        {/* Errors */}
        {activateError && <p className="mt-2 text-[12px] text-neg">{activateError}</p>}
        {bootstrap.isError && (
          <p className="mt-2 text-[12px] text-neg">
            {(bootstrap.error as Error)?.message ?? "Authorization failed"} — you can retry.
          </p>
        )}
        {bootstrap.isSuccess && account.nextAction === "bootstrap_allowances" && (
          <p className="mt-2 text-[12px] text-muted">
            Authorization submitted — confirming on-chain, this refreshes shortly.
          </p>
        )}
      </div>
    </>
  );
}
