"use client";

/**
 * In-app bridge funding: amount + live quote (fees/ETA/min received) and — on
 * EVM chains the app knows — a one-click chain-switch + ERC-20 transfer of the
 * selected asset to the generated bridge address. Non-EVM families keep the
 * copy-address flow; this panel still quotes them.
 */
import { useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { Check, ExternalLink, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { useBridgeQuote } from "@/lib/queries";
import { BRIDGE_SEND_CHAIN_IDS } from "@/lib/wagmi";
import type { FundsAsset, FundsQuoteResponse } from "@/lib/types";

const EXPLORERS: Record<string, string> = {
  "137": "https://polygonscan.com",
  "8453": "https://basescan.org",
  "42161": "https://arbiscan.io",
  "1": "https://etherscan.io",
};

const etaLabel = (ms: number | null): string | null => {
  if (ms === null) return null;
  if (ms < 90_000) return `~${Math.max(1, Math.round(ms / 1000))}s`;
  return `~${Math.round(ms / 60_000)} min`;
};

function QuoteCard({ quote }: { quote: FundsQuoteResponse }) {
  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-muted">You receive (est.)</span>
        <span className="tabular font-semibold text-fg">
          {quote.estOutputUsd !== null ? `$${quote.estOutputUsd.toFixed(2)} pUSD` : "—"}
        </span>
      </div>
      {quote.fees.totalImpactUsd !== null || quote.fees.gasUsd !== null ? (
        <div className="flex items-center justify-between text-muted">
          <span>Fees{quote.fees.appFeeLabel ? ` (${quote.fees.appFeeLabel})` : ""}</span>
          <span className="tabular">
            $
            {(
              quote.fees.totalImpactUsd ?? (quote.fees.appFeeUsd ?? 0) + (quote.fees.gasUsd ?? 0)
            ).toFixed(2)}
          </span>
        </div>
      ) : null}
      {quote.fees.minReceived !== null ? (
        <div className="flex items-center justify-between text-muted">
          <span>Min received</span>
          <span className="tabular">${quote.fees.minReceived.toFixed(2)}</span>
        </div>
      ) : null}
      {quote.estCheckoutTimeMs !== null ? (
        <div className="flex items-center justify-between text-muted">
          <span>ETA</span>
          <span>{etaLabel(quote.estCheckoutTimeMs)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function BridgeSendPanel({
  asset,
  bridgeAddress,
}: {
  asset: FundsAsset;
  bridgeAddress: string;
}) {
  const { address, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const qc = useQueryClient();
  const quote = useBridgeQuote();
  const [amount, setAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);

  const targetChainId = BRIDGE_SEND_CHAIN_IDS[asset.chainId];
  const sendable = asset.addressType === "evm" && targetChainId !== undefined && !!address;
  const onTargetChain = chainId === targetChainId;

  const balance = useBalance({
    address,
    token: asset.token.address as `0x${string}`,
    chainId: targetChainId ?? 137,
    query: { enabled: sendable },
  });

  const {
    writeContract,
    data: txHash,
    isPending: isSending,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: targetChainId ?? 137,
    query: { enabled: !!txHash },
  });

  const parsedAmount = Number(amount);
  const belowMin =
    Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount < asset.minCheckoutUsd;

  // Debounced quote refresh as the amount changes.
  useEffect(() => {
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
    const t = setTimeout(() => {
      try {
        quote.mutate({
          fromChainId: asset.chainId,
          fromTokenAddress: asset.token.address,
          fromAmountBaseUnit: parseUnits(amount, asset.token.decimals).toString(),
        });
      } catch {
        // Unparseable amount — skip quoting until it is valid.
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, asset.id]);

  const handleSend = () => {
    if (!sendable || !amount) return;
    setTxError(null);
    let parsed: bigint;
    try {
      parsed = parseUnits(amount, asset.token.decimals);
    } catch {
      setTxError("Invalid amount");
      return;
    }
    writeContract(
      {
        address: asset.token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "transfer",
        args: [bridgeAddress as `0x${string}`, parsed],
        chainId: targetChainId!,
      },
      {
        onError: (e) => setTxError(e.message),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ["bridge-deposits"] }),
      },
    );
  };

  const balanceFormatted = balance.data
    ? Number(formatUnits(balance.data.value, asset.token.decimals)).toFixed(2)
    : null;
  const explorer = EXPLORERS[asset.chainId];

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount (${asset.token.symbol}, min $${asset.minCheckoutUsd.toFixed(0)})`}
          min="0"
          step="1"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
        />
        {sendable && balanceFormatted !== null ? (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => setAmount(balanceFormatted)}
          >
            Max
          </Button>
        ) : null}
      </div>

      {belowMin ? (
        <ErrorNote message={`Minimum for this route is $${asset.minCheckoutUsd.toFixed(0)}.`} />
      ) : null}
      {quote.isPending ? <Spinner label="Quoting…" /> : null}
      {quote.data && !belowMin ? <QuoteCard quote={quote.data} /> : null}

      {sendable ? (
        txConfirmed ? (
          <div className="flex items-center gap-2 rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
            <Check size={14} />
            <span>
              Sent — the bridge will convert it to pUSD.{" "}
              {txHash && explorer ? (
                <a
                  href={`${explorer}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  View tx
                </a>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => {
                resetWrite();
                setAmount("");
              }}
              className="ml-auto text-pos/60 hover:text-pos"
            >
              <X size={13} />
            </button>
          </div>
        ) : txHash && isConfirming ? (
          <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
            <Spinner />
            <span>
              Confirming…{" "}
              {explorer ? (
                <a
                  href={`${explorer}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  <ExternalLink size={11} className="inline" />
                </a>
              ) : null}
            </span>
          </div>
        ) : !onTargetChain ? (
          <Button
            className="w-full"
            variant="outline"
            disabled={isSwitching}
            onClick={() => switchChain({ chainId: targetChainId! })}
          >
            {isSwitching ? "Check your wallet…" : `Switch wallet to ${asset.chainName}`}
          </Button>
        ) : (
          <Button
            className="w-full"
            variant="primary"
            disabled={!amount || belowMin || isSending}
            onClick={handleSend}
          >
            {isSending ? "Check your wallet…" : `Send ${asset.token.symbol} on ${asset.chainName}`}
          </Button>
        )
      ) : (
        <p className="text-[11px] leading-snug text-muted">
          Send from any wallet or exchange to the address above — the in-app send button covers
          Polygon, Base, Arbitrum and Ethereum.
        </p>
      )}

      {sendable && balanceFormatted !== null ? (
        <p className="text-[10px] text-faint">
          Connected wallet balance on {asset.chainName}: {balanceFormatted} {asset.token.symbol}
        </p>
      ) : null}
      {txError ? <ErrorNote message={txError} /> : null}
    </div>
  );
}
