"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/auth";
import { useTradingAccounts, useTradingWallet } from "@/lib/queries";
import { Empty, Spinner } from "@/components/ui";
import { WalletsSection } from "@/components/profile/WalletsSection";
import { TradingModeCards, WalletStepper } from "@/components/wallet/TradingModes";

export default function WalletPage() {
  return (
    <Suspense fallback={<Spinner label="Loading wallet…" />}>
      <WalletPageInner />
    </Suspense>
  );
}

function WalletPageInner() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const tradingAccounts = useTradingAccounts(signedIn);
  const walletStatus = useTradingWallet(signedIn);
  const privyEnabled = walletStatus.data?.privySigningEnabled ?? false;
  const params = useSearchParams();
  const autoOpenTopUp = params.get("topup") === "1";

  const internal =
    tradingAccounts.data?.accounts.find((a) => a.kind === "internal_privy" && a.isPrimary) ??
    tradingAccounts.data?.accounts.find((a) => a.kind === "internal_privy") ??
    null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Wallet</h1>
        <p className="mt-1 text-sm text-muted">
          Two ways to trade — pick either, or use both side by side.
        </p>
      </div>

      <TradingModeCards />

      {signedIn ? (
        <>
          <div className="space-y-2.5 rounded-xl border border-border bg-surface p-4 shadow-panel">
            <div className="text-[13px] font-semibold text-fg">Arima trading wallet readiness</div>
            <WalletStepper account={internal} />
            {!internal ? (
              <p className="text-[12px] text-muted">
                {privyEnabled
                  ? "Create your trading wallet below to unlock no-popup Smart Orders."
                  : "Server-managed trading wallets aren't enabled on this build yet — sign each trade from your connected wallet instead."}
              </p>
            ) : null}
          </div>
          <WalletsSection signedIn={signedIn} autoOpenTopUp={autoOpenTopUp} />
          <details className="rounded-xl border border-border bg-surface-2 px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium text-muted">
              How is the Arima trading wallet secured?
            </summary>
            <div className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-muted">
              <p>
                The wallet is created for you and secured by Privy&apos;s key infrastructure — the
                private key never touches arima&apos;s servers, and a policy restricts it to
                Polymarket contracts only.
              </p>
              <p>
                You fund it with only the amount you want to trade, and you can pause or remove it
                at any time. We never ask for your seed phrase or your primary wallet&apos;s private
                key.
              </p>
            </div>
          </details>
        </>
      ) : (
        <Empty>Connect your wallet and sign in to set up trading.</Empty>
      )}
    </div>
  );
}
