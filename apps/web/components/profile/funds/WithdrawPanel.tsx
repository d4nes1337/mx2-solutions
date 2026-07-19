"use client";

/**
 * Withdraw panel — owner-only, relayer-executed, gasless. The destination is
 * ALWAYS the connected login wallet (R-031): the server resolves it from the
 * session and the request schema rejects any destination field. The user only
 * chooses the chain it arrives on.
 *
 * After submit the panel stays put and tracks the withdrawal inline through
 * its real states (submitted → confirming on Polygon → [bridging →] complete)
 * — the Polymarket pattern — instead of bouncing to the History tab.
 */
import { useState } from "react";
import { useAccount } from "wagmi";
import { ArrowUpFromLine } from "lucide-react";
import { Button, ErrorNote, Spinner, cn } from "@/components/ui";
import { useWithdraw } from "@/lib/queries";
import { useActiveTransfers } from "@/lib/use-active-transfers";
import { ApiError } from "@/lib/api";
import { ChainIcon } from "@/components/wallet/ChainIcon";
import { AnimatedHeight, FadeRise } from "@/components/motion/primitives";
import { CopyButton } from "./shared";
import { TransferTracker } from "./TransferTracker";
import { TransferSuccess } from "./TransferSuccess";

/** EVM chains selectable as withdrawal destinations (login wallet address). */
const WITHDRAW_CHAINS: { chainId: string; name: string; note: string }[] = [
  { chainId: "137", name: "Polygon", note: "direct · gasless" },
  { chainId: "8453", name: "Base", note: "via bridge" },
  { chainId: "42161", name: "Arbitrum", note: "via bridge" },
  { chainId: "1", name: "Ethereum", note: "via bridge" },
];

export function WithdrawPanel({
  enabled,
  bridgeEnabled,
  availableUsd,
  onViewHistory,
}: {
  enabled: boolean;
  bridgeEnabled: boolean;
  availableUsd: number | null;
  onViewHistory: () => void;
}) {
  const { address } = useAccount();
  const withdraw = useWithdraw();
  const [amount, setAmount] = useState("");
  const [toChainId, setToChainId] = useState("137");
  const [confirming, setConfirming] = useState(false);
  // One idempotency key per confirm attempt: a double-click or retry of the
  // SAME confirmation can never produce two transfers. Regenerated after each
  // successful submit so a later, separate withdrawal is not deduped away.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  /** ActiveTransfer id ("w-…"/"bw-…") of the withdrawal being tracked inline. */
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const activity = useActiveTransfers({ enabled });

  if (!enabled) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        Withdrawals aren&apos;t enabled on this server yet. Your funds stay in the deposit wallet
        under your control either way.
      </p>
    );
  }

  // ── Inline tracking view after a successful submit ─────────────────────────
  if (trackedId) {
    const transfer = activity.transfers.find((t) => t.id === trackedId) ?? null;
    return (
      <AnimatedHeight>
        <div className="space-y-3">
          {transfer ? (
            transfer.status === "success" ? (
              <FadeRise>
                <TransferSuccess transfer={transfer} />
              </FadeRise>
            ) : (
              <TransferTracker transfer={transfer} />
            )
          ) : (
            <Spinner label="Submitting withdrawal…" />
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setTrackedId(null)}>
              New withdrawal
            </Button>
            <Button size="sm" variant="ghost" onClick={onViewHistory}>
              View history
            </Button>
          </div>
        </div>
      </AnimatedHeight>
    );
  }

  const parsed = Number(amount);
  const amountOk =
    Number.isFinite(parsed) && parsed >= 1 && (availableUsd === null || parsed <= availableUsd);
  const viaBridge = toChainId !== "137";
  const chainLabel = WITHDRAW_CHAINS.find((c) => c.chainId === toChainId)?.name ?? "Polygon";

  const submit = () => {
    withdraw.mutate(
      { amountUsd: parsed, idempotencyKey, ...(viaBridge ? { toChainId } : {}) },
      {
        onSuccess: (data) => {
          setAmount("");
          setConfirming(false);
          setIdempotencyKey(crypto.randomUUID());
          const id = data.bridgeWithdrawalId
            ? `bw-${data.bridgeWithdrawalId}`
            : data.withdrawalId
              ? `w-${data.withdrawalId}`
              : null;
          setTrackedId(id);
          if (!id) onViewHistory();
        },
      },
    );
  };

  const errorMsg =
    withdraw.error instanceof ApiError
      ? withdraw.error.message
      : withdraw.error instanceof Error
        ? withdraw.error.message
        : null;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface-2 p-3">
        <span className="text-[10px] uppercase tracking-wide text-muted">Withdraws to</span>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="flex-1 break-all font-mono text-[12px] text-fg">{address ?? "—"}</span>
          {address ? <CopyButton text={address} /> : null}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          Withdrawals can <span className="font-semibold text-fg">only</span> go to your connected
          login wallet — the destination can&apos;t be changed, by design. You choose the chain it
          arrives on.
        </p>
      </div>

      {bridgeEnabled ? (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Arrives on</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {WITHDRAW_CHAINS.map((c) => {
              const active = toChainId === c.chainId;
              return (
                <button
                  key={c.chainId}
                  type="button"
                  onClick={() => {
                    setToChainId(c.chainId);
                    setConfirming(false);
                  }}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-center transition-colors",
                    active
                      ? "border-accent/60 bg-accent/10"
                      : "border-border bg-surface-2 hover:border-border-strong",
                  )}
                >
                  <ChainIcon chainId={c.chainId} name={c.name} size={22} />
                  <span className="text-[12px] font-medium text-fg">{c.name}</span>
                  <span className="text-[9px] text-muted">{c.note}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex gap-2">
        <input
          type="number"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setConfirming(false);
          }}
          placeholder={
            availableUsd !== null ? `Amount (max $${availableUsd.toFixed(2)})` : "Amount (USD)"
          }
          min="1"
          step="1"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
        {availableUsd !== null && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => setAmount(String(Math.floor(availableUsd * 100) / 100))}
          >
            Max
          </Button>
        )}
      </div>

      <AnimatedHeight>
        {!confirming ? (
          <Button
            className="w-full"
            variant="outline"
            disabled={!amountOk}
            onClick={() => setConfirming(true)}
          >
            <ArrowUpFromLine size={13} aria-hidden /> Withdraw ${amount || "…"}
          </Button>
        ) : (
          <div className="space-y-2 rounded-lg border border-brand/40 bg-brand-soft/40 p-3">
            <p className="text-[12px] leading-snug text-fg">
              {viaBridge ? (
                <>
                  Send <span className="tabular font-semibold">${parsed.toFixed(2)}</span> to your
                  login wallet on <span className="font-semibold">{chainLabel}</span>? The bridge
                  converts it to USDC there — small bridge fees are deducted, and the server refuses
                  if the quote drops more than 1% below your amount.
                </>
              ) : (
                <>
                  Send <span className="tabular font-semibold">${parsed.toFixed(2)}</span> from the
                  deposit wallet to your login wallet? Gas is covered — the full amount arrives as
                  pUSD (Polymarket USD, 1:1 with USDC).
                </>
              )}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={withdraw.isPending} onClick={submit}>
                {withdraw.isPending ? "Submitting…" : "Confirm withdrawal"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </AnimatedHeight>

      {errorMsg ? <ErrorNote message={errorMsg} /> : null}
    </div>
  );
}
