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
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, erc20Abi } from "viem";
import { encode } from "uqr";
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
  useBridgeDeposits,
  useFeatureFlags,
  useFundsAssets,
  useSavedDepositAddresses,
  useWithdraw,
  useWithdrawals,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import {
  POLYGON_CHAIN_ID,
  POPULAR_GROUPS,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
  assetForSelection,
  chainsForGroup,
  defaultChainFor,
  searchAssets,
  symbolGroup,
} from "@/lib/funds-assets";
import { BridgeSendPanel } from "./BridgeSendPanel";
import type { FundsAsset } from "@/lib/types";

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
    token: USDC_E_ADDRESS,
    chainId: POLYGON_CHAIN_ID,
    query: { enabled: open && !!depositWalletAddress, refetchInterval: 15_000 },
  });
  const signerBalance = useBalance({
    address: (signerAddress ?? undefined) as `0x${string}` | undefined,
    token: USDC_E_ADDRESS,
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
          Top up with crypto from any major chain, withdraw to your login wallet, track transfers.
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
            bridgeEnabled={Boolean(flags.data?.bridgeWithdrawals)}
            availableUsd={depositUsd}
            onDone={() => setTab("history")}
          />
        ) : (
          <HistoryPanel open={open} bridgeEnabled={Boolean(flags.data?.bridgeFunding)} />
        )}
      </div>
    </div>
  );
}

// ── Add funds (any supported asset on any supported chain) ──────────────────

/** Scannable deposit address. Fixed white/black: scanners need the contrast. */
function QrBadge({ value }: { value: string }) {
  const qr = useMemo(() => encode(value, { border: 2, ecc: "M" }), [value]);
  const path = useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="h-[104px] w-[104px] shrink-0 rounded-md bg-white"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Deposit address QR code"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

const errorText = (e: unknown): string | null =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : null;

function TopUpPanel({
  depositWalletAddress,
  bridgeEnabled,
}: {
  depositWalletAddress: string;
  bridgeEnabled: boolean;
}) {
  const { chainId: connectedChainId } = useAccount();
  const assets = useFundsAssets(bridgeEnabled);
  const saved = useSavedDepositAddresses(bridgeEnabled);
  const create = useBridgeDepositAddresses();
  const { mutate: createAddresses, isIdle: createIdle } = create;

  const [group, setGroup] = useState<string>("USDC");
  const [chainChoice, setChainChoice] = useState<string | null>(null);
  const [customAssetId, setCustomAssetId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  const assetRows = useMemo(() => assets.data?.assets ?? [], [assets.data]);

  // First open with a provisioned wallet: generate the per-family deposit
  // addresses once, silently — the server persists and re-serves them.
  const needsCreate =
    bridgeEnabled &&
    saved.isSuccess &&
    !!saved.data.depositWalletAddress &&
    Object.keys(saved.data.addresses).length === 0;
  useEffect(() => {
    if (needsCreate && createIdle) createAddresses();
  }, [needsCreate, createIdle, createAddresses]);

  const customAsset = customAssetId
    ? (assetRows.find((asset) => asset.id === customAssetId) ?? null)
    : null;
  const activeGroup = customAsset ? symbolGroup(customAsset.token.symbol) : group;
  const chains = useMemo(() => chainsForGroup(assetRows, activeGroup), [assetRows, activeGroup]);
  const selectedChain =
    (chainChoice ? chains.find((chain) => chain.chainId === chainChoice) : null) ??
    defaultChainFor(chains, connectedChainId);
  const selectedAsset: FundsAsset | null =
    customAsset && selectedChain && customAsset.chainId === selectedChain.chainId
      ? customAsset
      : selectedChain
        ? assetForSelection(assetRows, activeGroup, selectedChain.chainId)
        : null;

  const familyAddresses = saved.data?.addresses ?? {};
  const bridgeAddress = selectedAsset ? (familyAddresses[selectedAsset.addressType] ?? null) : null;
  const isDirectUsdc =
    activeGroup === "USDC" && selectedChain?.chainId === String(POLYGON_CHAIN_ID);

  const popular = useMemo(
    () => POPULAR_GROUPS.filter((g) => chainsForGroup(assetRows, g).length > 0),
    [assetRows],
  );
  const searchResults = useMemo(
    () => (pickerOpen ? searchAssets(assetRows, search) : []),
    [pickerOpen, assetRows, search],
  );

  const loadError =
    errorText(assets.error) ?? errorText(saved.error) ?? errorText(create.error) ?? null;

  if (!bridgeEnabled) {
    return <DirectPolygonTopUp depositWalletAddress={depositWalletAddress} />;
  }

  if (assets.isLoading || saved.isLoading) {
    return <Spinner label="Loading assets…" />;
  }

  const pickAsset = (asset: FundsAsset) => {
    const g = symbolGroup(asset.token.symbol);
    // Pin the exact catalog entry only when the group+chain resolver would
    // land elsewhere — otherwise the normal chips reflect the selection.
    const resolved = assetForSelection(assetRows, g, asset.chainId);
    setGroup(g);
    setChainChoice(asset.chainId);
    setCustomAssetId(resolved?.id === asset.id ? null : asset.id);
    setPickerOpen(false);
    setSearch("");
  };

  return (
    <div className="space-y-3">
      {/* Token-first picker: the big five, then the whole catalog. */}
      <div className="flex flex-wrap gap-1.5">
        {popular.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => {
              setGroup(g);
              setCustomAssetId(null);
              setChainChoice(null);
              setPickerOpen(false);
            }}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
              !customAsset && activeGroup === g
                ? "border-accent/60 bg-accent/10 text-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {g}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
            customAsset || pickerOpen
              ? "border-accent/60 bg-accent/10 text-fg"
              : "border-border bg-surface-2 text-muted hover:text-fg",
          )}
        >
          {customAsset ? `${customAsset.token.symbol} ▾` : "More ▾"}
        </button>
      </div>

      {pickerOpen ? (
        <div className="rounded-md border border-border bg-surface-2 p-2">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${assetRows.length} assets or chains…`}
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent/50 focus:outline-none"
          />
          <ul className="mt-1.5 max-h-44 space-y-0.5 overflow-y-auto">
            {searchResults.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => pickAsset(asset)}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-surface"
                >
                  <span className="min-w-0 truncate text-[13px] font-medium text-fg">
                    {asset.token.symbol}
                    <span className="ml-1.5 text-[11px] font-normal text-muted">
                      {asset.token.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{asset.chainName}</span>
                </button>
              </li>
            ))}
            {searchResults.length === 0 ? (
              <li className="px-2 py-1.5 text-[12px] text-muted">Nothing matches.</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {chains.length > 1 ? (
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <span className="shrink-0">Network</span>
          <select
            value={selectedChain?.chainId ?? ""}
            onChange={(e) => setChainChoice(e.target.value)}
            className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
          >
            {chains.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.chainName}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedAsset && bridgeAddress ? (
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted">
                  Deposit {selectedAsset.token.symbol} on {selectedAsset.chainName}
                </span>
                <Badge tone="neutral">min ${selectedAsset.minCheckoutUsd.toFixed(0)}</Badge>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="flex-1 break-all font-mono text-[12px] leading-relaxed text-fg">
                  {bridgeAddress}
                </span>
                <CopyButton text={bridgeAddress} />
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-muted">
                Send from any wallet or exchange — it converts automatically and lands in your
                balance in a few minutes.
              </p>
            </div>
            <QrBadge value={bridgeAddress} />
          </div>
        </div>
      ) : create.isPending || (needsCreate && !create.isError) ? (
        // Spinner only while the create is actually in flight (or about to
        // auto-fire). A failed create falls through to the error + Retry below
        // instead of hanging here forever.
        <Spinner label="Preparing your deposit address…" />
      ) : selectedAsset && saved.isSuccess && !loadError ? (
        <ErrorNote
          message={`No ${selectedAsset.chainName} deposit address is available yet — try again in a moment.`}
        />
      ) : null}

      {selectedAsset && bridgeAddress ? (
        <BridgeSendPanel
          key={selectedAsset.id}
          asset={selectedAsset}
          bridgeAddress={bridgeAddress}
          directDepositWallet={isDirectUsdc ? depositWalletAddress : undefined}
        />
      ) : null}

      {loadError ? (
        <div className="space-y-2">
          <ErrorNote message={loadError} />
          {create.isError ? (
            <Button type="button" size="sm" variant="outline" onClick={() => createAddresses()}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fallback when the server has Bridge funding switched off: plain USDC.e
 * transfer on Polygon to the deposit wallet. Self-contained on purpose — the
 * bridge-first panel above shares no state with it.
 */
function DirectPolygonTopUp({ depositWalletAddress }: { depositWalletAddress: string }) {
  const { address, chainId } = useAccount();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);

  const connectedBalance = useBalance({
    address,
    token: USDC_E_ADDRESS,
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
        address: USDC_E_ADDRESS,
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
  const wrongChain = !!address && chainId !== POLYGON_CHAIN_ID;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-surface-2 p-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted">
                Deposit USDC.e on Polygon
              </span>
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
            <p className="mt-1.5 text-[11px] leading-snug text-muted">
              Send from any wallet or exchange. It converts automatically and becomes your trading
              balance.
            </p>
          </div>
          <QrBadge value={depositWalletAddress} />
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
    </div>
  );
}

// ── Withdraw (owner-only, relayer-executed, gasless) ────────────────────────

/** EVM chains selectable as withdrawal destinations (login wallet address). */
const WITHDRAW_CHAINS: { chainId: string; label: string; direct?: boolean }[] = [
  { chainId: "137", label: "Polygon — direct, gasless", direct: true },
  { chainId: "8453", label: "Base — via bridge" },
  { chainId: "42161", label: "Arbitrum — via bridge" },
  { chainId: "1", label: "Ethereum — via bridge" },
];

function WithdrawPanel({
  enabled,
  bridgeEnabled,
  availableUsd,
  onDone,
}: {
  enabled: boolean;
  bridgeEnabled: boolean;
  availableUsd: number | null;
  onDone: () => void;
}) {
  const { address } = useAccount();
  const withdraw = useWithdraw();
  const [amount, setAmount] = useState("");
  const [toChainId, setToChainId] = useState("137");
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
  const viaBridge = toChainId !== "137";
  const chainLabel =
    WITHDRAW_CHAINS.find((c) => c.chainId === toChainId)?.label.split(" — ")[0] ?? "Polygon";

  const submit = () => {
    withdraw.mutate(
      { amountUsd: parsed, idempotencyKey, ...(viaBridge ? { toChainId } : {}) },
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
          login wallet — the destination can&apos;t be changed, by design. You choose the chain it
          arrives on.
        </p>
      </div>

      {bridgeEnabled ? (
        <label className="block space-y-1 text-[11px] text-muted">
          <span>Destination chain</span>
          <select
            value={toChainId}
            onChange={(e) => {
              setToChainId(e.target.value);
              setConfirming(false);
            }}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg focus:border-accent/50 focus:outline-none"
          >
            {WITHDRAW_CHAINS.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
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

      {errorMsg ? <ErrorNote message={errorMsg} /> : null}
    </div>
  );
}

// ── History (withdrawals + bridge deposits, newest first) ───────────────────

const STATE_TONE: Record<string, string> = {
  requested: "text-muted",
  submitted: "text-accent",
  confirmed: "text-pos",
  failed: "text-neg",
  // Bridge deposit states
  detected: "text-accent",
  processing: "text-accent",
  origin_confirmed: "text-accent",
  completed: "text-pos",
};

const DEPOSIT_STATE_LABEL: Record<string, string> = {
  detected: "detected",
  processing: "processing",
  origin_confirmed: "confirmed at source",
  submitted: "arriving",
  completed: "completed",
  failed: "failed",
};

const BRIDGE_WITHDRAWAL_STATE_LABEL: Record<string, string> = {
  requested: "starting",
  address_created: "starting",
  polygon_submitted: "leaving Polygon",
  polygon_confirmed: "leaving Polygon",
  bridging: "bridging",
  completed: "completed",
  failed_address: "failed (funds safe)",
  failed_polygon: "failed (funds safe)",
  failed_bridge: "needs support",
};

const CHAIN_NAMES: Record<string, string> = {
  "137": "Polygon",
  "8453": "Base",
  "42161": "Arbitrum",
  "1": "Ethereum",
};

interface HistoryRow {
  id: string;
  direction: "in" | "out";
  amountLabel: string;
  subtitle: string;
  state: string;
  stateLabel: string;
  txUrl: string | null;
  at: number;
}

function HistoryPanel({ open, bridgeEnabled }: { open: boolean; bridgeEnabled: boolean }) {
  const history = useWithdrawals(open);
  const deposits = useBridgeDeposits(open && bridgeEnabled);
  const assets = useFundsAssets(open && bridgeEnabled);

  const assetFor = (chainId: string, tokenAddress: string) =>
    assets.data?.assets.find(
      (a) => a.chainId === chainId && a.token.address.toLowerCase() === tokenAddress.toLowerCase(),
    ) ?? null;

  const rows: HistoryRow[] = [
    ...(history.data?.withdrawals ?? []).map(
      (w): HistoryRow => ({
        id: `w-${w.id}`,
        direction: "out",
        amountLabel: `−$${w.amountUsd.toFixed(2)}`,
        subtitle: "Withdrawal to login wallet",
        state: w.state,
        stateLabel: w.state,
        txUrl: w.transactionHash ? `https://polygonscan.com/tx/${w.transactionHash}` : null,
        at: new Date(w.createdAt).getTime(),
      }),
    ),
    ...(history.data?.bridgeWithdrawals ?? []).map(
      (w): HistoryRow => ({
        id: `bw-${w.id}`,
        direction: "out",
        amountLabel: `−$${w.amountUsd.toFixed(2)}`,
        subtitle: `Withdrawal to ${CHAIN_NAMES[w.toChainId] ?? `chain ${w.toChainId}`} (bridge)`,
        state: w.state.startsWith("failed") ? "failed" : w.state,
        stateLabel: BRIDGE_WITHDRAWAL_STATE_LABEL[w.state] ?? w.state,
        txUrl: w.polygonTxHash ? `https://polygonscan.com/tx/${w.polygonTxHash}` : null,
        at: new Date(w.createdAt).getTime(),
      }),
    ),
    ...(deposits.data?.deposits ?? []).map((d): HistoryRow => {
      const asset = assetFor(d.fromChainId, d.fromTokenAddress);
      const amount =
        asset && d.fromAmountBaseUnit !== ""
          ? Number(formatUnits(BigInt(d.fromAmountBaseUnit), asset.token.decimals))
          : null;
      return {
        id: `d-${d.id}`,
        direction: "in",
        amountLabel:
          amount !== null ? `+${amount.toFixed(2)} ${asset?.token.symbol ?? ""}` : "Deposit",
        subtitle: `Bridge deposit${asset ? ` from ${asset.chainName}` : ""}`,
        state: d.state,
        stateLabel: DEPOSIT_STATE_LABEL[d.state] ?? d.state,
        txUrl: null,
        at: new Date(d.createdAt).getTime(),
      };
    }),
  ].sort((a, b) => b.at - a.at);

  if (history.isLoading || (bridgeEnabled && deposits.isLoading)) {
    return <Spinner label="Loading transfers…" />;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        No transfers yet. Deposits appear here as they are detected; direct Polygon sends show on
        Polygonscan under the deposit wallet address.
      </p>
    );
  }
  return (
    <ul className="max-h-64 space-y-1.5 overflow-y-auto">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            {row.state === "confirmed" || row.state === "completed" ? (
              <ArrowDownToLine size={13} className="text-pos" aria-hidden />
            ) : (
              <History size={13} className="text-muted" aria-hidden />
            )}
            <div>
              <div className="tabular text-[13px] font-medium text-fg">{row.amountLabel}</div>
              <div className="text-[10px] text-faint">
                {row.subtitle} · {new Date(row.at).toLocaleString()}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("text-[11px] font-medium capitalize", STATE_TONE[row.state])}>
              {row.stateLabel}
            </span>
            {row.txUrl ? (
              <a
                href={row.txUrl}
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
