"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/auth";
import { useTradingAccounts, useTradingWallet } from "@/lib/queries";
import { Empty, Spinner } from "@/components/ui";
import { WalletsSection } from "@/components/profile/WalletsSection";
import { NotificationsSection } from "@/components/profile/NotificationsSection";
import { TradingSetupPanel } from "@/components/wallet/TradingModes";
import { EnableArimaWalletDialog } from "@/components/wallet/EnableArimaWalletDialog";

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
  const [enableArimaOpen, setEnableArimaOpen] = useState(false);

  const internal =
    tradingAccounts.data?.accounts.find((a) => a.kind === "internal_privy" && a.isPrimary) ??
    tradingAccounts.data?.accounts.find((a) => a.kind === "internal_privy") ??
    null;
  // Opted in = a visible Arima (internal) account exists. Only then do we lead
  // the user into its Create → Activate → Fund → Trade setup. Before opt-in the
  // main/connected wallet is the whole story (brief §5.1).
  const optedIn = internal !== null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Wallet</h1>
        <p className="mt-1 text-sm text-muted">
          Your connected wallet is the default — you sign each trade yourself. The Arima Wallet is
          an optional Beta for automated execution.
        </p>
      </div>

      {signedIn ? (
        <>
          {/* Main/connected wallet leads and is visually primary; the Arima
              Wallet appears here as a secondary, opt-in Beta entry. */}
          <WalletsSection
            signedIn={signedIn}
            autoOpenTopUp={autoOpenTopUp}
            onEnableArima={() => setEnableArimaOpen(true)}
          />
          {optedIn ? <TradingSetupPanel account={internal} privyEnabled={privyEnabled} /> : null}
          <NotificationsSection signedIn={signedIn} />
          <EnableArimaWalletDialog
            open={enableArimaOpen}
            onClose={() => setEnableArimaOpen(false)}
          />
        </>
      ) : (
        <Empty>Connect your wallet and sign in to set up trading.</Empty>
      )}
    </div>
  );
}
