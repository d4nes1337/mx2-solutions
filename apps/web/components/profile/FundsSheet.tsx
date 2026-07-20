"use client";

/**
 * The Funds sheet — one place for everything money: balances of both wallets,
 * deposits of any Bridge-supported asset on any supported chain (token-first
 * picker, auto-generated per-family deposit addresses, QR + in-app send),
 * owner-only withdrawal, and history. Polygon USDC.e held by the connected
 * wallet still takes the free direct route automatically.
 * Withdrawals can ONLY go to the connected login wallet: the server resolves
 * the destination from the session and the request schema rejects any
 * destination field (R-031). The sheet just states that plainly.
 *
 * Panels live in ./funds/; this file is the shell (animated overlay, balances
 * strip, tabs). The active tab is global state (funds-ui store) so the pill
 * and deep links can land on a specific tab.
 */
import { useAccount, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { RefreshCcw, X } from "lucide-react";
import { Segmented } from "@/components/ui";
import { AnimatedNumber, FlashOnChange } from "@/components/motion";
import { SheetShell, TabPanes } from "@/components/motion/primitives";
import { useFeatureFlags } from "@/lib/queries";
import { useFundsUi } from "@/lib/funds-ui";
import { POLYGON_CHAIN_ID, PUSD_ADDRESS, USDC_E_ADDRESS } from "@/lib/funds-assets";
import { TopUpPanel } from "./funds/TopUpPanel";
import { WithdrawPanel } from "./funds/WithdrawPanel";
import { HistoryPanel } from "./funds/HistoryPanel";

export interface FundsSheetProps {
  open: boolean;
  onClose: () => void;
  depositWalletAddress: string;
  /** The embedded Privy signer EOA (balance shown read-only). */
  signerAddress?: string | null;
}

export function FundsSheet({
  open,
  onClose,
  depositWalletAddress,
  signerAddress,
}: FundsSheetProps) {
  const tab = useFundsUi((s) => s.tab);
  const setTab = useFundsUi((s) => s.setTab);
  const flags = useFeatureFlags();

  const depositBalance = useBalance({
    address: depositWalletAddress as `0x${string}`,
    token: PUSD_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: open ? 5_000 : 15_000 },
  });
  // Raw USDC.e sitting in the deposit wallet: Polymarket converts deposits to
  // pUSD, so anything here is "arrived, conversion pending".
  const unconvertedBalance = useBalance({
    address: depositWalletAddress as `0x${string}`,
    token: USDC_E_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: open ? 5_000 : 15_000 },
  });
  const signerBalance = useBalance({
    address: (signerAddress ?? undefined) as `0x${string}` | undefined,
    token: USDC_E_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!signerAddress },
  });
  // The LOGIN wallet — where withdrawals land. Without this cell, money that
  // left the trading account looked like it vanished (owner beta finding).
  const { address: loginAddress } = useAccount();
  const loginPusd = useBalance({
    address: loginAddress,
    token: PUSD_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!loginAddress, refetchInterval: open ? 5_000 : 15_000 },
  });
  const loginUsdc = useBalance({
    address: loginAddress,
    token: USDC_E_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!loginAddress, refetchInterval: open ? 5_000 : 15_000 },
  });

  const depositUsd = depositBalance.data ? Number(formatUnits(depositBalance.data.value, 6)) : null;
  const unconvertedUsd = unconvertedBalance.data
    ? Number(formatUnits(unconvertedBalance.data.value, 6))
    : 0;
  const loginUsd =
    loginPusd.data || loginUsdc.data
      ? Number(formatUnits(loginPusd.data?.value ?? 0n, 6)) +
        Number(formatUnits(loginUsdc.data?.value ?? 0n, 6))
      : null;
  const signerUsd = signerBalance.data ? Number(formatUnits(signerBalance.data.value, 6)) : 0;

  return (
    <SheetShell
      open={open}
      onClose={onClose}
      label="Funds"
      panelClassName="w-full max-w-md rounded-t-xl border border-border bg-bg p-5 shadow-xl sm:rounded-xl"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded p-1 text-muted hover:text-fg"
        aria-label="Close"
      >
        <X size={16} />
      </button>

      <h2 className="mb-1 text-[15px] font-semibold text-fg">Funds</h2>
      <p className="mb-3 text-xs text-muted">
        Top up with crypto from any major chain, withdraw to your login wallet, track transfers.
      </p>

      {/* Balances strip: where the money is — trading account vs your wallet. */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] uppercase tracking-wide text-muted"
              title="Your Arima trading account (deposit wallet) — the balance strategies and orders spend from."
            >
              In trading account
            </span>
            <button
              type="button"
              onClick={() => {
                void depositBalance.refetch();
                void loginPusd.refetch();
                void loginUsdc.refetch();
              }}
              className="text-muted hover:text-fg"
              aria-label="Refresh balances"
            >
              <RefreshCcw size={11} />
            </button>
          </div>
          <div className="tabular mt-0.5 text-[15px] font-semibold text-fg">
            {depositUsd !== null ? (
              <FlashOnChange value={depositUsd}>
                <AnimatedNumber value={depositUsd} format={(n) => `$${n.toFixed(2)}`} />
              </FlashOnChange>
            ) : (
              "—"
            )}
          </div>
          {unconvertedUsd > 0.009 ? (
            <div
              className="mt-0.5 text-[10px] text-muted"
              title="Polymarket converts USDC.e deposits to pUSD automatically — this amount has arrived but is not spendable yet."
            >
              +${unconvertedUsd.toFixed(2)} converting…
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <span
            className="text-[10px] uppercase tracking-wide text-muted"
            title="Your connected login wallet on Polygon (pUSD + USDC.e) — withdrawals land here."
          >
            In your wallet
          </span>
          <div className="tabular mt-0.5 text-[15px] font-semibold text-fg">
            {loginUsd !== null ? (
              <FlashOnChange value={loginUsd}>
                <AnimatedNumber value={loginUsd} format={(n) => `$${n.toFixed(2)}`} />
              </FlashOnChange>
            ) : (
              "—"
            )}
          </div>
          {signerUsd > 0.009 ? (
            <div
              className="mt-0.5 text-[10px] text-muted"
              title="The signing wallet only pays for signatures — funds live in the trading account. Sweeping this balance is a planned follow-up."
            >
              +${signerUsd.toFixed(2)} signer dust
            </div>
          ) : null}
        </div>
      </div>

      <div className="mb-3">
        <Segmented
          options={[
            { value: "topup", label: "Add funds" },
            { value: "withdraw", label: "Withdraw" },
            { value: "history", label: "History" },
          ]}
          value={tab}
          onChange={(t) => setTab(t)}
          size="md"
          grow
        />
      </div>

      <TabPanes activeKey={tab}>
        {tab === "topup" ? (
          <TopUpPanel
            depositWalletAddress={depositWalletAddress}
            bridgeEnabled={Boolean(flags.data?.bridgeFunding)}
          />
        ) : tab === "withdraw" ? (
          <WithdrawPanel
            enabled={Boolean(flags.data?.walletWithdraw)}
            bridgeEnabled={Boolean(flags.data?.bridgeWithdrawals)}
            availableUsd={depositUsd}
            onViewHistory={() => setTab("history")}
          />
        ) : (
          <HistoryPanel open={open} />
        )}
      </TabPanes>
    </SheetShell>
  );
}
