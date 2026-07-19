"use client";

/**
 * Single app-wide host for the Funds sheet + pending-transfer pill, mounted
 * once in the root layout. Every "Deposit"/"Add funds" button and the
 * /wallet?topup=1 deep link drive it through the funds-ui store, so the
 * sheet exists exactly once and the pill survives navigation.
 */
import { useSession } from "@/lib/auth";
import { useTradingWallet } from "@/lib/queries";
import { useFundsUi } from "@/lib/funds-ui";
import { FUNDS_DEMO_ENABLED } from "@/lib/funds-demo";
import { FundsSheet } from "../FundsSheet";
import { TransferPill } from "./TransferPill";
import { DemoTransfers } from "./DemoTransfers";

export function FundsHost() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const wallet = useTradingWallet(signedIn);
  const open = useFundsUi((s) => s.open);
  const closeSheet = useFundsUi((s) => s.closeSheet);

  const provisioned = wallet.data?.provisioned === true;
  const depositWalletAddress = wallet.data?.depositWalletAddress ?? null;
  // Demo mode keeps the surface mounted even without a session so the whole
  // flow can be watched against fabricated transfers.
  if (!FUNDS_DEMO_ENABLED && (!signedIn || !provisioned || !depositWalletAddress)) return null;

  return (
    <>
      <FundsSheet
        open={open}
        onClose={closeSheet}
        depositWalletAddress={depositWalletAddress ?? ""}
        signerAddress={wallet.data?.embeddedAddress ?? null}
      />
      <TransferPill />
      {FUNDS_DEMO_ENABLED ? <DemoTransfers /> : null}
    </>
  );
}
