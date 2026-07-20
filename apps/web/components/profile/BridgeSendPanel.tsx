"use client";

/**
 * In-app funding send: amount + live quote (fees/ETA/min received) and — on
 * EVM chains the app knows — a one-click chain-switch + transfer of the
 * selected asset (ERC-20 or native coin) to the generated bridge address.
 * Non-EVM families keep the copy-address flow; this panel still quotes them.
 *
 * Free-route optimization: when the selection is USDC-on-Polygon and the
 * connected wallet holds USDC.e, the send goes straight to the user's deposit
 * wallet (Polymarket auto-converts USDC.e to pUSD) — zero bridge fees, no
 * minimum — instead of through the bridge.
 */
import { useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  useSendTransaction,
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
import {
  POLYGON_CHAIN_ID,
  USDC_E_ADDRESS,
  isNativePlaceholder,
  isStableSymbol,
} from "@/lib/funds-assets";
import type { FundsAsset, FundsQuoteResponse } from "@/lib/types";
import { AmountSlider } from "./funds/AmountSlider";

const EXPLORERS: Record<string, string> = {
  "137": "https://polygonscan.com",
  "8453": "https://basescan.org",
  "42161": "https://arbiscan.io",
  "1": "https://etherscan.io",
  "10": "https://optimistic.etherscan.io",
  "56": "https://bscscan.com",
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
          {quote.estOutputUsd !== null ? `$${quote.estOutputUsd.toFixed(2)}` : "—"}
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
  directDepositWallet,
  usdPerUnit,
}: {
  asset: FundsAsset;
  bridgeAddress: string;
  /**
   * Set when the selection is USDC-on-Polygon: the user's own deposit wallet.
   * If the connected wallet holds USDC.e there, the send skips the bridge.
   */
  directDepositWallet?: string;
  /** USD per token of the selected holding, for the amount slider's readout. */
  usdPerUnit?: number | null;
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
  const isNative = isNativePlaceholder(asset.token.address);

  // Free-route check: USDC.e held by the connected wallet on Polygon.
  const usdceBalance = useBalance({
    address,
    token: USDC_E_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: !!address && !!directDepositWallet },
  });
  const useDirect =
    !!directDepositWallet && !!usdceBalance.data && usdceBalance.data.value > 0n && sendable;

  const sendToken = useDirect ? USDC_E_ADDRESS : (asset.token.address as `0x${string}`);
  const sendDecimals = useDirect ? 6 : asset.token.decimals;
  const recipient = (useDirect ? directDepositWallet : bridgeAddress) as `0x${string}`;

  const balance = useBalance({
    address,
    token: isNative && !useDirect ? undefined : sendToken,
    chainId: targetChainId ?? POLYGON_CHAIN_ID,
    query: { enabled: sendable },
  });

  const {
    writeContract,
    data: erc20TxHash,
    isPending: isSendingErc20,
    reset: resetErc20,
  } = useWriteContract();
  const {
    sendTransaction,
    data: nativeTxHash,
    isPending: isSendingNative,
    reset: resetNative,
  } = useSendTransaction();
  const txHash = erc20TxHash ?? nativeTxHash;
  const isSending = isSendingErc20 || isSendingNative;
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: targetChainId ?? POLYGON_CHAIN_ID,
    query: { enabled: !!txHash },
  });

  const parsedAmount = Number(amount);
  // Route minimums are USD. For volatile assets the raw amount is not USD, so
  // trust the quote's USD estimate; for stables the raw amount is close enough.
  const amountUsd =
    quote.data?.estInputUsd ??
    (isStableSymbol(asset.token.symbol) && Number.isFinite(parsedAmount) ? parsedAmount : null);
  const belowMin =
    !useDirect && amountUsd !== null && amountUsd > 0 && amountUsd < asset.minCheckoutUsd;

  // Debounced quote refresh as the amount changes (skipped on the free route).
  useEffect(() => {
    if (useDirect) return;
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
  }, [amount, asset.id, useDirect]);

  const handleSend = () => {
    if (!sendable || !amount) return;
    setTxError(null);
    let parsed: bigint;
    try {
      parsed = parseUnits(amount, sendDecimals);
    } catch {
      setTxError("Invalid amount");
      return;
    }
    const onDone = {
      onError: (e: Error) => setTxError(e.message),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["bridge-deposits"] });
        void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
        void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      },
    };
    if (isNative && !useDirect) {
      sendTransaction({ to: recipient, value: parsed, chainId: targetChainId! }, onDone);
    } else {
      writeContract(
        {
          address: sendToken,
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, parsed],
          chainId: targetChainId!,
        },
        onDone,
      );
    }
  };

  const balanceFormatted = balance.data
    ? Number(formatUnits(balance.data.value, balance.data.decimals)).toFixed(
        balance.data.decimals > 8 ? 4 : 2,
      )
    : null;
  const explorer = EXPLORERS[asset.chainId];
  const sendSymbol = useDirect ? "USDC.e" : asset.token.symbol;

  return (
    <div className="space-y-2">
      <AmountSlider
        value={amount}
        onChange={setAmount}
        maxAmount={
          sendable && balance.data
            ? Number(formatUnits(balance.data.value, balance.data.decimals))
            : null
        }
        decimals={balance.data && balance.data.decimals > 8 ? 4 : 2}
        unitLabel={sendSymbol}
        usdPerUnit={usdPerUnit ?? null}
        minUsd={useDirect ? null : asset.minCheckoutUsd}
        placeholder={
          useDirect
            ? "Amount (USDC.e)"
            : `Amount (${asset.token.symbol}, min $${asset.minCheckoutUsd.toFixed(0)})`
        }
      />

      {useDirect ? (
        <p className="text-[11px] text-muted">
          Your USDC.e goes straight to your deposit wallet — no fees, no minimum, arrives 1:1.
        </p>
      ) : null}
      {belowMin ? (
        <ErrorNote message={`Minimum for this route is $${asset.minCheckoutUsd.toFixed(0)}.`} />
      ) : null}
      {!useDirect && quote.isPending ? <Spinner label="Quoting…" /> : null}
      {!useDirect && quote.data && !belowMin ? <QuoteCard quote={quote.data} /> : null}

      {sendable ? (
        txConfirmed ? (
          <div className="flex items-center gap-2 rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
            <Check size={14} />
            <span>
              Sent — it lands in your balance shortly.{" "}
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
                resetErc20();
                resetNative();
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
            {isSending ? "Check your wallet…" : `Send ${sendSymbol} on ${asset.chainName}`}
          </Button>
        )
      ) : null}

      {sendable && balanceFormatted !== null ? (
        <p className="text-[10px] text-faint">
          Connected wallet balance on {asset.chainName}: {balanceFormatted} {sendSymbol}
        </p>
      ) : null}
      {txError ? <ErrorNote message={txError} /> : null}
    </div>
  );
}
