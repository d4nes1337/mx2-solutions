"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCcw, Zap } from "lucide-react";
import { useAccount } from "wagmi";
import {
  useProvisionTradingWallet,
  useReissueTradingWallet,
  useSetupCredentials,
  useTradingAccounts,
  useTradingWallet,
  useTradingWalletHealth,
} from "@/lib/queries";
import type { TradingAccount } from "@/lib/types";
import { signClobAuth } from "@/lib/clob-auth";
import type { Eip1193Provider } from "@/lib/order-sign";
import { Badge, Button, Card, CardHeader, ErrorNote, Spinner } from "@/components/ui";
import { WalletCard } from "./WalletCard";

export function WalletsSection({
  signedIn,
  autoOpenTopUp = false,
  onEnableArima,
}: {
  signedIn: boolean;
  /** Deep link (/wallet?topup=1): open the primary wallet's top-up sheet. */
  autoOpenTopUp?: boolean;
  /**
   * Opt-in gate for a FRESH Arima Wallet (brief §5.3.6): the create button
   * opens the explicit confirmation instead of provisioning directly. A
   * restore (the wallet already exists at the provider) stays direct — the
   * user already consented once.
   */
  onEnableArima?: () => void;
}) {
  const { address, connector } = useAccount();
  const tradingAccounts = useTradingAccounts(signedIn);
  const walletStatus = useTradingWallet(signedIn);
  const provisionWallet = useProvisionTradingWallet();
  const setupCreds = useSetupCredentials();
  const reissue = useReissueTradingWallet();

  const [credsError, setCredsError] = useState<string | null>(null);
  const [credsSuccess, setCredsSuccess] = useState<string | null>(null);

  const accounts = tradingAccounts.data?.accounts ?? [];
  const hasPrivyWallet = accounts.some((a) => a.kind === "internal_privy");
  const privyEnabled = walletStatus.data?.privySigningEnabled ?? false;
  // A Privy mapping can exist with no visible account (the user hit "Remove
  // wallet", which only archives the row) — the wallet and funds still exist.
  const hasWalletMapping = walletStatus.data?.provisioned ?? false;

  // One provider round-trip to catch wallets deleted outside the app (e.g. in
  // the Privy dashboard). Whenever a wallet is supposed to exist at the
  // provider — including the archived-account case.
  const health = useTradingWalletHealth(
    signedIn && privyEnabled && (hasPrivyWallet || hasWalletMapping),
  );
  const walletMissing = health.data?.walletHealth === "missing";
  const firstPrivyWithDeposit = accounts.find(
    (a) => a.kind === "internal_privy" && a.depositWalletAddress,
  );

  const handleSetupCredentials = async (account: TradingAccount) => {
    setCredsError(null);
    setCredsSuccess(null);
    if (!address || !connector) {
      setCredsError("Connect a wallet first.");
      return;
    }
    if (address.toLowerCase() !== account.signerAddress.toLowerCase()) {
      setCredsError(
        `Switch your connected wallet to ${account.signerAddress.slice(0, 6)}…${account.signerAddress.slice(-4)} first.`,
      );
      return;
    }
    try {
      const provider = (await connector.getProvider()) as Eip1193Provider;
      const clobAuth = await signClobAuth(provider, address, 137);
      await setupCreds.mutateAsync({
        ...clobAuth,
        tradingAccountId: account.id,
      });
      setCredsSuccess("Trading credentials set up successfully.");
    } catch (e) {
      setCredsError(e instanceof Error ? e.message : "Credential setup failed.");
    }
  };

  if (!signedIn) return null;

  return (
    <Card>
      <CardHeader
        right={
          <button
            type="button"
            onClick={() => {
              void tradingAccounts.refetch();
              void walletStatus.refetch();
            }}
            className="rounded p-1 text-muted hover:text-fg"
            title="Refresh"
            aria-label="Refresh trading wallets"
          >
            <RefreshCcw size={13} className={tradingAccounts.isFetching ? "animate-spin" : ""} />
          </button>
        }
      >
        Trading account details
      </CardHeader>

      <div className="space-y-2 p-4">
        {/* Provider-side deletion detected → offer the safe repair path. */}
        {walletMissing ? (
          <div className="space-y-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
            <p className="flex items-start gap-2 text-[13px] text-warn">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              Your Arima trading wallet no longer exists at the wallet provider (it may have been
              deleted in the Privy dashboard). Re-create it to keep trading — the old wallet entry
              will be archived.
            </p>
            <Button
              size="sm"
              variant="primary"
              disabled={reissue.isPending}
              onClick={() => reissue.mutate()}
            >
              {reissue.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Re-create trading wallet
            </Button>
            {reissue.error ? (
              <p className="text-[12px] text-neg">{(reissue.error as Error).message}</p>
            ) : null}
          </div>
        ) : null}
        {reissue.data?.reissued ? (
          <div className="rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
            Fresh trading wallet created. Activate and fund it below to resume trading.
          </div>
        ) : null}

        {tradingAccounts.isLoading ? (
          <Spinner label="Loading wallets…" />
        ) : tradingAccounts.error ? (
          <ErrorNote message={(tradingAccounts.error as Error).message} />
        ) : accounts.length === 0 && (!privyEnabled || hasPrivyWallet) ? (
          <p className="text-sm text-muted">No trading accounts found.</p>
        ) : (
          accounts.map((account) => (
            <WalletCard
              key={account.id}
              account={account}
              loginAddress={address ?? ""}
              onSetupCredentials={(acc) => void handleSetupCredentials(acc)}
              autoOpenTopUp={autoOpenTopUp && account.id === firstPrivyWithDeposit?.id}
            />
          ))
        )}

        {/* Credential feedback */}
        {credsError && <ErrorNote message={credsError} />}
        {credsSuccess && (
          <div className="rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
            {credsSuccess}
          </div>
        )}

        {/* No internal wallet → a proper empty state with Create as the primary
            action. Creating when a mapping still exists RESTORES the same
            wallet (same address, same funds) — say so. */}
        {signedIn && privyEnabled && !hasPrivyWallet && (
          <div className="space-y-2 rounded-md border border-dashed border-border bg-surface-2/50 px-3 py-3">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              {hasWalletMapping ? "Restore your Arima Wallet" : "Arima Wallet"}
              <Badge tone="neutral">Beta</Badge>
            </p>
            <p className="text-[12px] leading-snug text-muted">
              {hasWalletMapping
                ? "You removed your trading wallet earlier — it still exists safely at the provider. Restoring brings the same wallet (and any funds on it) right back."
                : "Optional: a separate, ring-fenced balance so strategies can execute automatically within strict limits. Your main wallet stays the default — you keep signing each trade yourself until you turn this on."}
            </p>
            <Button
              size="sm"
              variant={hasWalletMapping ? "primary" : "outline"}
              disabled={provisionWallet.isPending}
              onClick={() => (hasWalletMapping ? provisionWallet.mutate() : onEnableArima?.())}
            >
              {provisionWallet.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : hasWalletMapping ? (
                <Plus size={12} />
              ) : (
                <Zap size={12} />
              )}
              {hasWalletMapping ? "Restore Arima trading wallet" : "Enable Arima Wallet Beta"}
            </Button>
            {provisionWallet.error && (
              <p className="mt-1 text-[12px] text-neg">
                {(provisionWallet.error as Error).message}
              </p>
            )}
          </div>
        )}
        {provisionWallet.data?.alreadyProvisioned && hasPrivyWallet ? (
          <div className="rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
            Your trading wallet is back — same address, same funds.
          </div>
        ) : null}

        {/* Feature notes */}
        {signedIn && walletStatus.data && !privyEnabled && (
          <p className="text-[11px] text-muted">
            Server-managed trading wallets aren&apos;t enabled on this build — you can still trade
            by signing each order in your connected wallet.
          </p>
        )}
        {signedIn && walletStatus.data && privyEnabled && !walletStatus.data.relayerEnabled && (
          <p className="text-[11px] text-muted">
            No-popup trading isn&apos;t active on this server yet. You can still trade by signing
            each order in your connected wallet.
          </p>
        )}
      </div>
    </Card>
  );
}
