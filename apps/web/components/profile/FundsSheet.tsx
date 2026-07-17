"use client";

/**
 * The Funds sheet — one place for everything money: balances of both wallets,
 * direct Polygon funding, staged multi-chain Bridge funding, owner-only
 * withdrawal, and history.
 * Withdrawals can ONLY go to the connected login wallet: the server resolves
 * the destination from the session and the request schema rejects any
 * destination field (R-031). The sheet just states that plainly.
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, erc20Abi } from "viem";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  ExternalLink,
  History,
  RefreshCcw,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Segmented, Spinner, cn } from "@/components/ui";
import {
  useBridgeDepositAddresses,
  useFeatureFlags,
  useFundsAssets,
  useWithdraw,
  useWithdrawals,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import type { FundsAsset } from "@/lib/types";

// Bridged USDC.e on Polygon mainnet (same constant as allowance-bootstrap.ts)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
// pUSD — what deposit wallets actually hold (the V2 exchanges' collateral,
// 1:1 USD; INTEGRATION_VERIFIED §23). Withdrawals send pUSD.
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const POLYGON_CHAIN_ID = 137;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-1 text-muted hover:text-fg"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-pos" /> : <Copy size={13} />}
    </button>
  );
}

type FundsTab = "topup" | "withdraw" | "history";

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
  const [tab, setTab] = useState<FundsTab>("topup");
  const flags = useFeatureFlags();

  const depositBalance = useBalance({
    address: depositWalletAddress as `0x${string}`,
    token: PUSD_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: 15_000 },
  });
  // Raw USDC.e sitting in the deposit wallet: Polymarket converts deposits to
  // pUSD, so anything here is "arrived, conversion pending".
  const unconvertedBalance = useBalance({
    address: depositWalletAddress as `0x${string}`,
    token: USDC_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: 15_000 },
  });
  const signerBalance = useBalance({
    address: (signerAddress ?? undefined) as `0x${string}` | undefined,
    token: USDC_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!signerAddress },
  });

  const depositUsd = depositBalance.data ? Number(formatUnits(depositBalance.data.value, 6)) : null;
  const unconvertedUsd = unconvertedBalance.data
    ? Number(formatUnits(unconvertedBalance.data.value, 6))
    : 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative z-10 w-full max-w-md rounded-t-xl border border-border bg-bg p-5 shadow-xl sm:rounded-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-muted hover:text-fg"
        >
          <X size={16} />
        </button>

        <h2 className="mb-1 text-[15px] font-semibold text-fg">Funds</h2>
        <p className="mb-3 text-xs text-muted">
          Add pUSD trading funds, withdraw to your login wallet, and track transfers.
        </p>

        {/* Balances strip */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted">Deposit wallet</span>
              <button
                type="button"
                onClick={() => void depositBalance.refetch()}
                className="text-muted hover:text-fg"
                aria-label="Refresh deposit balance"
              >
                <RefreshCcw size={11} />
              </button>
            </div>
            <div className="tabular mt-0.5 text-[15px] font-semibold text-fg">
              {depositUsd !== null ? `$${depositUsd.toFixed(2)}` : "—"}
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
              title="The signing wallet only pays for signatures — funds live in the deposit wallet. Sweeping this balance is a planned follow-up."
            >
              Signer (gas/dust)
            </span>
            <div className="tabular mt-0.5 text-[15px] font-semibold text-muted">
              {signerBalance.data
                ? `$${Number(formatUnits(signerBalance.data.value, 6)).toFixed(2)}`
                : "—"}
            </div>
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

        {tab === "topup" ? (
          <TopUpPanel
            depositWalletAddress={depositWalletAddress}
            bridgeEnabled={Boolean(flags.data?.bridgeFunding)}
          />
        ) : tab === "withdraw" ? (
          <WithdrawPanel
            enabled={Boolean(flags.data?.walletWithdraw)}
            availableUsd={depositUsd}
            onDone={() => setTab("history")}
          />
        ) : (
          <HistoryPanel open={open} />
        )}
      </div>
    </div>
  );
}

// ── Add funds (direct Polygon transfer + staged Bridge addresses) ───────────

type FundingMode = "direct" | "bridge";

const preferredAsset = (assets: FundsAsset[], chainId: string | null): FundsAsset | null => {
  const scoped = chainId ? assets.filter((asset) => asset.chainId === chainId) : assets;
  return (
    scoped.find((asset) => asset.token.symbol.toUpperCase() === "USDC") ??
    scoped.find((asset) => asset.token.symbol.toUpperCase().includes("USDC")) ??
    scoped.find((asset) => asset.token.symbol.toUpperCase() === "USDT") ??
    scoped[0] ??
    null
  );
};

function TopUpPanel({
  depositWalletAddress,
  bridgeEnabled,
}: {
  depositWalletAddress: string;
  bridgeEnabled: boolean;
}) {
  const { address, chainId } = useAccount();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);
  const [mode, setMode] = useState<FundingMode>("direct");
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const assets = useFundsAssets(bridgeEnabled);
  const bridgeDeposit = useBridgeDepositAddresses();

  const connectedBalance = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: !!address },
  });

  const {
    writeContract,
    data: txHash,
    isPending: isSending,
    reset: resetWrite,
  } = useWriteContract();
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

  const connectedBalanceFormatted = connectedBalance.data
    ? Number(formatUnits(connectedBalance.data.value, 6)).toFixed(2)
    : null;
  const chains = assets.data?.chains ?? [];
  const assetRows = assets.data?.assets ?? [];
  const selectedChain = selectedChainId ?? chains[0]?.chainId ?? null;
  const visibleAssets = selectedChain
    ? assetRows.filter((asset) => asset.chainId === selectedChain)
    : assetRows;
  const selectedAsset =
    visibleAssets.find((asset) => asset.id === selectedAssetId) ??
    preferredAsset(assetRows, selectedChain);
  const bridgeAddress = selectedAsset
    ? (bridgeDeposit.data?.addresses[selectedAsset.addressType] ?? null)
    : null;
  const bridgeError =
    bridgeDeposit.error instanceof ApiError
      ? bridgeDeposit.error.message
      : bridgeDeposit.error instanceof Error
        ? bridgeDeposit.error.message
        : assets.error instanceof ApiError
          ? assets.error.message
          : assets.error instanceof Error
            ? assets.error.message
            : null;

  useEffect(() => {
    if (!bridgeEnabled || chains.length === 0) return;
    if (!selectedChainId) setSelectedChainId(chains[0]?.chainId ?? null);
  }, [bridgeEnabled, chains, selectedChainId]);

  useEffect(() => {
    if (!selectedAsset || selectedAsset.id === selectedAssetId) return;
    setSelectedAssetId(selectedAsset.id);
  }, [selectedAsset, selectedAssetId]);

  return (
    <div className="space-y-3">
      <Segmented<FundingMode>
        options={[
          { value: "direct", label: "Polygon USDC.e" },
          { value: "bridge", label: "Other chains", disabled: !bridgeEnabled },
        ]}
        value={mode}
        onChange={setMode}
        size="md"
        grow
      />

      {!bridgeEnabled ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2/50 px-3 py-2 text-[12px] leading-relaxed text-muted">
          Multi-chain deposits are staged behind a server flag. Today, use Polygon USDC.e directly;
          when Bridge funding is enabled, this sheet will show the live chain and token catalog.
        </div>
      ) : null}

      {mode === "direct" ? (
        <DirectPolygonTopUp
          address={address}
          amount={amount}
          chainId={chainId}
          connectedBalanceFormatted={connectedBalanceFormatted}
          depositWalletAddress={depositWalletAddress}
          handleSend={handleSend}
          isConfirming={isConfirming}
          isSending={isSending}
          resetWrite={resetWrite}
          setAmount={setAmount}
          setTxError={setTxError}
          txConfirmed={txConfirmed}
          txError={txError}
          txHash={txHash}
        />
      ) : bridgeEnabled ? (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] text-muted">
              <span>Chain</span>
              <select
                value={selectedChain ?? ""}
                onChange={(e) => {
                  setSelectedChainId(e.target.value);
                  setSelectedAssetId(null);
                }}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
                disabled={assets.isLoading || chains.length === 0}
              >
                {chains.map((chain) => (
                  <option key={chain.chainId} value={chain.chainId}>
                    {chain.chainName}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-[11px] text-muted">
              <span>Coin</span>
              <select
                value={selectedAsset?.id ?? ""}
                onChange={(e) => setSelectedAssetId(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
                disabled={assets.isLoading || visibleAssets.length === 0}
              >
                {visibleAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.token.symbol} · {asset.token.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {assets.isLoading ? <Spinner label="Loading supported chains..." /> : null}

          {selectedAsset ? (
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted">Bridge route</span>
                <Badge tone="neutral">min ${selectedAsset.minCheckoutUsd.toFixed(0)}</Badge>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                Send {selectedAsset.token.symbol} on {selectedAsset.chainName}. Polymarket Bridge
                converts it into pUSD in your trading deposit wallet.
              </p>
            </div>
          ) : null}

          {!bridgeDeposit.data ? (
            <Button
              type="button"
              className="w-full"
              variant="outline"
              disabled={!selectedAsset || bridgeDeposit.isPending}
              onClick={() => bridgeDeposit.mutate()}
            >
              {bridgeDeposit.isPending ? "Generating..." : "Generate deposit address"}
            </Button>
          ) : bridgeAddress ? (
            <div className="rounded-md border border-brand/40 bg-brand-soft/30 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted">
                Send only {selectedAsset?.token.symbol} on {selectedAsset?.chainName}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="flex-1 break-all font-mono text-[12px] text-fg">
                  {bridgeAddress}
                </span>
                <CopyButton text={bridgeAddress} />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Sending a different chain or token can delay or fail the deposit. Status tracking is
                the next backend slice; keep your source wallet transaction hash.
              </p>
            </div>
          ) : (
            <ErrorNote message="Bridge did not return an address for this chain family." />
          )}

          {bridgeError ? <ErrorNote message={bridgeError} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function DirectPolygonTopUp({
  address,
  amount,
  chainId,
  connectedBalanceFormatted,
  depositWalletAddress,
  handleSend,
  isConfirming,
  isSending,
  resetWrite,
  setAmount,
  setTxError,
  txConfirmed,
  txError,
  txHash,
}: {
  address: `0x${string}` | undefined;
  amount: string;
  chainId: number | undefined;
  connectedBalanceFormatted: string | null;
  depositWalletAddress: string;
  handleSend: () => void;
  isConfirming: boolean;
  isSending: boolean;
  resetWrite: () => void;
  setAmount: (amount: string) => void;
  setTxError: (error: string | null) => void;
  txConfirmed: boolean;
  txError: string | null;
  txHash: `0x${string}` | undefined;
}) {
  const wrongChain = !!address && chainId !== POLYGON_CHAIN_ID;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-surface-2 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted">
            Direct deposit wallet
          </span>
          <Badge tone="neutral">USDC.e</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="flex-1 break-all font-mono text-[12px] text-fg">
            {depositWalletAddress}
          </span>
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
      </div>
      {address ? (
        <div className="space-y-3">
          <div className="text-[11px] text-muted">
            Send from connected wallet
            {connectedBalanceFormatted !== null ? (
              <span className="ml-1 text-fg">(balance: ${connectedBalanceFormatted} USDC)</span>
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
              <button
                type="button"
                onClick={() => {
                  resetWrite();
                  setTxError(null);
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
        <p className="text-sm text-muted">Connect a wallet to send Polygon USDC.e directly.</p>
      )}

      <p className="text-[11px] text-muted">
        After the transfer confirms and Polymarket converts it to pUSD, click &ldquo;Check
        funds&rdquo; if the wallet is not marked ready yet.
      </p>
    </div>
  );
}

// ── Withdraw (owner-only, relayer-executed, gasless) ────────────────────────

function WithdrawPanel({
  enabled,
  availableUsd,
  onDone,
}: {
  enabled: boolean;
  availableUsd: number | null;
  onDone: () => void;
}) {
  const { address } = useAccount();
  const withdraw = useWithdraw();
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  // One idempotency key per confirm attempt: a double-click or retry of the
  // SAME confirmation can never produce two transfers.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  if (!enabled) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        Withdrawals aren&apos;t enabled on this server yet. Your funds stay in the deposit wallet
        under your control either way.
      </p>
    );
  }

  const parsed = Number(amount);
  const amountOk =
    Number.isFinite(parsed) && parsed >= 1 && (availableUsd === null || parsed <= availableUsd);

  const submit = () => {
    withdraw.mutate(
      { amountUsd: parsed, idempotencyKey },
      {
        onSuccess: () => {
          setAmount("");
          setConfirming(false);
          onDone();
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
          login wallet — the destination can&apos;t be changed, by design.
        </p>
      </div>

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
            Send <span className="tabular font-semibold">${parsed.toFixed(2)}</span> from the
            deposit wallet to your login wallet? Gas is covered — the full amount arrives as pUSD
            (Polymarket USD, 1:1 with USDC).
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

      {errorMsg ? <ErrorNote message={errorMsg} /> : null}
    </div>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

const STATE_TONE: Record<string, string> = {
  requested: "text-muted",
  submitted: "text-accent",
  confirmed: "text-pos",
  failed: "text-neg",
};

function HistoryPanel({ open }: { open: boolean }) {
  const history = useWithdrawals(open);
  const rows = history.data?.withdrawals ?? [];

  if (history.isLoading) return <Spinner label="Loading transfers…" />;
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        No withdrawals yet. Top-ups appear on Polygonscan via the deposit wallet address.
      </p>
    );
  }
  return (
    <ul className="max-h-64 space-y-1.5 overflow-y-auto">
      {rows.map((w) => (
        <li
          key={w.id}
          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            {w.state === "confirmed" ? (
              <ArrowDownToLine size={13} className="text-pos" aria-hidden />
            ) : (
              <History size={13} className="text-muted" aria-hidden />
            )}
            <div>
              <div className="tabular text-[13px] font-medium text-fg">
                ${w.amountUsd.toFixed(2)}
              </div>
              <div className="text-[10px] text-faint">{new Date(w.createdAt).toLocaleString()}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("text-[11px] font-medium capitalize", STATE_TONE[w.state])}>
              {w.state}
            </span>
            {w.transactionHash ? (
              <a
                href={`https://polygonscan.com/tx/${w.transactionHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-muted hover:text-fg"
              >
                <ExternalLink size={12} />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
