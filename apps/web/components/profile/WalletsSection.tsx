"use client";

import { useState } from "react";
import { Loader2, Plus, RefreshCcw } from "lucide-react";
import { useAccount } from "wagmi";
import {
  useBootstrapAllowances,
  useProvisionTradingWallet,
  useSetupCredentials,
  useTradingAccounts,
  useTradingWallet,
} from "@/lib/queries";
import type { TradingAccount } from "@/lib/types";
import { signClobAuth } from "@/lib/clob-auth";
import type { Eip1193Provider } from "@/lib/order-sign";
import { Button, Card, CardHeader, ErrorNote, Spinner } from "@/components/ui";
import { WalletCard } from "./WalletCard";

export function WalletsSection({ signedIn }: { signedIn: boolean }) {
  const { address, connector } = useAccount();
  const tradingAccounts = useTradingAccounts(signedIn);
  const walletStatus = useTradingWallet(signedIn);
  const provisionWallet = useProvisionTradingWallet();
  const setupCreds = useSetupCredentials();
  const bootstrap = useBootstrapAllowances();

  const [credsError, setCredsError] = useState<string | null>(null);
  const [credsSuccess, setCredsSuccess] = useState<string | null>(null);

  const accounts = tradingAccounts.data?.accounts ?? [];
  const hasPrivyWallet = accounts.some((a) => a.kind === "internal_privy");
  const privyEnabled = walletStatus.data?.privySigningEnabled ?? false;

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
          >
            <RefreshCcw
              size={13}
              className={tradingAccounts.isFetching ? "animate-spin" : ""}
            />
          </button>
        }
      >
        Trading wallets
      </CardHeader>

      <div className="space-y-2 p-4">
        {tradingAccounts.isLoading ? (
          <Spinner label="Loading wallets…" />
        ) : tradingAccounts.error ? (
          <ErrorNote message={(tradingAccounts.error as Error).message} />
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted">No trading accounts found.</p>
        ) : (
          accounts.map((account) => (
            <WalletCard
              key={account.id}
              account={account}
              loginAddress={address ?? ""}
              onSetupCredentials={(acc) => void handleSetupCredentials(acc)}
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

        {/* Create Privy wallet */}
        {signedIn && privyEnabled && !hasPrivyWallet && (
          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={provisionWallet.isPending}
              onClick={() => provisionWallet.mutate()}
            >
              {provisionWallet.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              Create Privy wallet
            </Button>
            {provisionWallet.error && (
              <p className="mt-1 text-[12px] text-neg">
                {(provisionWallet.error as Error).message}
              </p>
            )}
          </div>
        )}

        {/* Relayer feature note */}
        {signedIn && walletStatus.data && !walletStatus.data.relayerEnabled && (
          <p className="text-[11px] text-muted">
            Server-side signing (no-popup) is not yet active on this server. External wallet browser signing is available.
          </p>
        )}
      </div>
    </Card>
  );
}
