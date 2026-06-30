"use client";

import { useState } from "react";
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, erc20Abi } from "viem";
import { Check, Copy, ExternalLink, RefreshCcw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Spinner } from "@/components/ui";

// Bridged USDC.e on Polygon mainnet (same constant as allowance-bootstrap.ts)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const POLYGON_CHAIN_ID = 137;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={copy} className="rounded p-1 text-muted hover:text-fg" title="Copy">
      {copied ? <Check size={13} className="text-pos" /> : <Copy size={13} />}
    </button>
  );
}

interface TopUpSheetProps {
  open: boolean;
  onClose: () => void;
  depositWalletAddress: string;
}

export function TopUpSheet({ open, onClose, depositWalletAddress }: TopUpSheetProps) {
  const { address, chainId } = useAccount();
  const qc = useQueryClient();

  const [amount, setAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);

  // USDC balance of the deposit wallet
  const depositBalance = useBalance({
    address: depositWalletAddress as `0x${string}`,
    token: USDC_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: 15_000 },
  });

  // Connected wallet USDC balance
  const connectedBalance = useBalance({
    address: address,
    token: USDC_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!address },
  });

  const { writeContract, data: txHash, isPending: isSending, reset: resetWrite } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  const handleSend = () => {
    if (!amount || !depositWalletAddress || !address) return;
    setTxError(null);
    let parsed: bigint;
    try {
      parsed = parseUnits(amount, 6);
    } catch {
      setTxError("Invalid amount");
      return;
    }
    writeContract(
      {
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [depositWalletAddress as `0x${string}`, parsed],
        chainId: POLYGON_CHAIN_ID,
      },
      {
        onError: (e) => setTxError(e.message),
        onSuccess: () => {
          setAmount("");
          void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
          void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
        },
      },
    );
  };

  const handleReset = () => {
    resetWrite();
    setTxError(null);
    setAmount("");
  };

  const wrongChain = !!address && chainId !== POLYGON_CHAIN_ID;
  const connectedBalanceFormatted = connectedBalance.data
    ? Number(formatUnits(connectedBalance.data.value, 6)).toFixed(2)
    : null;
  const depositBalanceFormatted = depositBalance.data
    ? Number(formatUnits(depositBalance.data.value, 6)).toFixed(2)
    : null;

  if (!open) return null;

  return (
    /* Overlay */
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Sheet */}
      <div className="relative z-10 w-full max-w-md rounded-t-xl border border-border bg-bg p-5 shadow-xl sm:rounded-xl">
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-muted hover:text-fg"
        >
          <X size={16} />
        </button>

        <h2 className="mb-1 text-[15px] font-semibold text-fg">Top up trading wallet</h2>
        <p className="mb-4 text-xs text-muted">
          Send USDC (bridged, Polygon network) to your Polymarket deposit wallet to enable trading.
        </p>

        {/* Deposit wallet address */}
        <div className="mb-4 rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted">Your deposit wallet (Polygon)</span>
            <Badge tone="neutral">USDC.e</Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="flex-1 break-all font-mono text-[12px] text-fg">{depositWalletAddress}</span>
            <CopyButton text={depositWalletAddress} />
            <a
              href={`https://polygonscan.com/address/${depositWalletAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-fg"
            >
              <ExternalLink size={13} />
            </a>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <span className="text-muted">Current balance</span>
            <div className="flex items-center gap-1.5">
              {depositBalance.isLoading ? (
                <Spinner />
              ) : depositBalanceFormatted !== null ? (
                <span className="font-semibold text-fg">${depositBalanceFormatted} USDC</span>
              ) : (
                <span className="text-muted">—</span>
              )}
              <button
                type="button"
                onClick={() => void depositBalance.refetch()}
                className="text-muted hover:text-fg"
              >
                <RefreshCcw size={11} />
              </button>
            </div>
          </div>
        </div>

        {/* Send from connected wallet */}
        {address ? (
          <div className="space-y-3">
            <div className="text-[11px] text-muted">
              Send from connected wallet
              {connectedBalanceFormatted !== null ? (
                <span className="ml-1 text-fg">
                  (balance: ${connectedBalanceFormatted} USDC)
                </span>
              ) : null}
            </div>

            {wrongChain && (
              <ErrorNote message="Switch your wallet to Polygon (chain 137) to send USDC." />
            )}

            {txConfirmed ? (
              <div className="flex items-center gap-2 rounded-md border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos">
                <Check size={14} />
                <span>
                  Transfer confirmed!{" "}
                  {txHash && (
                    <a
                      href={`https://polygonscan.com/tx/${txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      View tx
                    </a>
                  )}
                </span>
                <button type="button" onClick={handleReset} className="ml-auto text-pos/60 hover:text-pos">
                  <X size={13} />
                </button>
              </div>
            ) : txHash && isConfirming ? (
              <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
                <Spinner />
                <span>
                  Confirming…{" "}
                  <a
                    href={`https://polygonscan.com/tx/${txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    View tx
                  </a>
                </span>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount (USDC)"
                  min="0"
                  step="1"
                  className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
                />
                {connectedBalanceFormatted !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => setAmount(connectedBalanceFormatted ?? "")}
                  >
                    Max
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!amount || wrongChain || isSending}
                  onClick={handleSend}
                >
                  {isSending ? "Sending…" : "Send USDC"}
                </Button>
              </div>
            )}

            {txError && <ErrorNote message={txError} />}
          </div>
        ) : (
          <p className="text-sm text-muted">Connect a wallet to send USDC directly from here.</p>
        )}

        <p className="mt-4 text-[11px] text-muted">
          You can also bridge USDC from Ethereum or other chains and send to the deposit wallet address above.
          After funding, click &ldquo;Check &amp; activate trading&rdquo; on the wallet card.
        </p>
      </div>
    </div>
  );
}
