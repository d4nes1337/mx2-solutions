"use client";

/**
 * Header trading-balance pill + Deposit button. Visible once the user is signed
 * in and their Arima deposit wallet exists, so funding is always one click away
 * (like Polymarket's persistent Deposit button). Balance is pUSD in the deposit
 * wallet, counting up live when funds land; Deposit opens the single global
 * Funds sheet (FundsHost).
 */
import { ArrowDownToLine } from "lucide-react";
import { useSession } from "@/lib/auth";
import { useTradingWallet, useTradingWalletBalance } from "@/lib/queries";
import { useFundsUi } from "@/lib/funds-ui";
import { AnimatedNumber, FlashOnChange } from "@/components/motion";

export function HeaderWallet() {
  const session = useSession();
  const signedIn = Boolean(session.data);
  const wallet = useTradingWallet(signedIn);
  const provisioned = wallet.data?.provisioned === true;
  const depositWalletAddress = wallet.data?.depositWalletAddress ?? null;
  const balance = useTradingWalletBalance(signedIn && provisioned && !!depositWalletAddress);
  const openSheet = useFundsUi((s) => s.openSheet);

  // Nothing to show until there's a funded-capable wallet.
  if (!signedIn || !provisioned || !depositWalletAddress) return null;

  const pusd = balance.data?.depositWalletUsdc;

  return (
    <div className="flex items-center overflow-hidden rounded-md border border-border bg-surface-2">
      {/* Balance — full label on desktop, tighter on mobile. Counts up and
          flashes green when a deposit lands. */}
      <span className="tabular flex items-baseline gap-1 px-2.5 py-1.5 text-[13px] font-semibold text-fg">
        {pusd == null ? (
          balance.isLoading ? (
            "…"
          ) : (
            "—"
          )
        ) : (
          <FlashOnChange value={pusd}>
            <AnimatedNumber value={pusd} format={(n) => `$${n.toFixed(2)}`} />
          </FlashOnChange>
        )}
        <span className="hidden text-[9px] font-medium uppercase tracking-wide text-faint sm:inline">
          pUSD
        </span>
      </span>
      {/* Deposit */}
      <button
        type="button"
        onClick={() => openSheet("topup")}
        className="flex items-center gap-1 self-stretch border-l border-border bg-brand px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-brand-strong"
      >
        <ArrowDownToLine size={13} aria-hidden />
        <span className="hidden sm:inline">Deposit</span>
      </button>
    </div>
  );
}
