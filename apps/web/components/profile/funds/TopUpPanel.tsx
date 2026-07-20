"use client";

/**
 * Add-funds panel: token-first Bridge deposit picker (popular chips + full
 * searchable catalog), network grid ordered by connected-wallet balances,
 * per-family deposit address with QR, and the in-app BridgeSendPanel. Falls
 * back to a plain Polygon USDC.e transfer when Bridge funding is off.
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, erc20Abi } from "viem";
import { Check, ChevronDown, ExternalLink, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Spinner, cn } from "@/components/ui";
import {
  useBridgeDepositAddresses,
  useDismissDeposit,
  useFundsAssets,
  usePrices,
  useSavedDepositAddresses,
} from "@/lib/queries";
import { AmountPresets } from "./AmountPresets";
import {
  POLYGON_CHAIN_ID,
  POPULAR_GROUPS,
  USDC_E_ADDRESS,
  assetForSelection,
  chainsForGroup,
  defaultChainFor,
  searchAssets,
  symbolGroup,
} from "@/lib/funds-assets";
import { useWalletHoldings, type WalletHoldingsResult } from "@/lib/use-wallet-holdings";
import type { WalletHolding } from "@/lib/funds-holdings";
import { useActiveTransfers } from "@/lib/use-active-transfers";
import { useFundsUi } from "@/lib/funds-ui";
import { ChainIcon } from "@/components/wallet/ChainIcon";
import { AnimatePresence } from "motion/react";
import { AnimatedHeight, FadeRise } from "@/components/motion/primitives";
import { BridgeSendPanel } from "../BridgeSendPanel";
import { CopyButton, QrBadge, errorText } from "./shared";
import { TransferTracker } from "./TransferTracker";
import { TransferSuccess } from "./TransferSuccess";
import type { FundsAsset } from "@/lib/types";

export function TopUpPanel({
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
  // Nothing is "chosen" until the user taps a holding or a manual asset — the
  // send section stays hidden until then, so the panel opens holdings-first.
  const [picked, setPicked] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

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

  // Connected-wallet holdings across the readable EVM chains — the primary,
  // Polymarket-style "pick what you already have" list. Prices value volatile
  // assets in USD (stablecoins are valued 1:1 inside the hook).
  const prices = usePrices(bridgeEnabled);
  const wallet = useWalletHoldings(assetRows, prices.data?.prices ?? {});

  const selectedChain =
    (chainChoice ? chains.find((chain) => chain.chainId === chainChoice) : null) ??
    defaultChainFor(chains, connectedChainId);
  const selectedAsset: FundsAsset | null =
    customAsset && selectedChain && customAsset.chainId === selectedChain.chainId
      ? customAsset
      : selectedChain
        ? assetForSelection(assetRows, activeGroup, selectedChain.chainId)
        : null;

  // Match the current selection back to a scanned holding so the send slider
  // can show a live USD value for volatile assets.
  const selectedHolding =
    selectedAsset != null
      ? (wallet.holdings.find((h) => h.asset.id === selectedAsset.id) ?? null)
      : null;
  const usdPerUnit =
    selectedHolding && selectedHolding.usd != null && selectedHolding.amount > 0
      ? selectedHolding.usd / selectedHolding.amount
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

  // Live inbound activity: fast-poll while the address is on screen (the user
  // is likely mid-transfer), and surface a staged tracker the moment the
  // Bridge detects the deposit — the "we see it" moment.
  const hasBridgeAddress = Object.keys(familyAddresses).length > 0;
  const activity = useActiveTransfers({ enabled: bridgeEnabled, watching: hasBridgeAddress });
  const closeSheet = useFundsUi((s) => s.closeSheet);
  const dismissDeposit = useDismissDeposit();
  const inboundActive = activity.active.filter((t) => t.direction === "in");
  const inboundArrived = activity.justCompleted.filter((t) => t.direction === "in");

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
    setPicked(true);
    setPickerOpen(false);
    setSearch("");
  };

  const openManual = () => {
    setManualOpen(true);
    setPickerOpen(true);
  };

  return (
    <div className="space-y-3">
      {/* Primary: what the connected wallet already holds, ready to deposit. */}
      <HoldingsList
        wallet={wallet}
        selectedAssetId={picked ? (selectedAsset?.id ?? null) : null}
        onPick={(h) => pickAsset(h.asset)}
        onManual={openManual}
      />

      {/* Selected asset → in-app send with the amount slider. */}
      {picked && selectedAsset ? (
        bridgeAddress ? (
          <div className="space-y-2 rounded-md border border-border bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <ChainIcon chainId={selectedAsset.chainId} name={selectedAsset.chainName} size={18} />
              <span className="text-[12px] font-medium text-fg">
                {symbolGroup(selectedAsset.token.symbol)} · {selectedAsset.chainName}
              </span>
              <span className="ml-auto">
                <Badge tone="neutral">min ${selectedAsset.minCheckoutUsd.toFixed(0)}</Badge>
              </span>
            </div>
            <BridgeSendPanel
              key={selectedAsset.id}
              asset={selectedAsset}
              bridgeAddress={bridgeAddress}
              directDepositWallet={isDirectUsdc ? depositWalletAddress : undefined}
              usdPerUnit={usdPerUnit}
            />
          </div>
        ) : create.isPending || (needsCreate && !create.isError) ? (
          <Spinner label="Preparing your deposit address…" />
        ) : saved.isSuccess && !loadError ? (
          <ErrorNote
            message={`No ${selectedAsset.chainName} deposit address is available yet — try again in a moment.`}
          />
        ) : null
      ) : null}

      {/* Live inbound transfers: success celebration + staged trackers. */}
      <AnimatePresence initial={false}>
        {inboundArrived.slice(0, 1).map((t) => (
          <FadeRise key={`done-${t.id}`}>
            <TransferSuccess transfer={t} onPrimary={closeSheet} />
          </FadeRise>
        ))}
        {inboundActive.map((t) => (
          <FadeRise key={t.id}>
            <TransferTracker
              transfer={t}
              // A deposit stuck non-terminal for over an hour is dismissible —
              // the record moves to history; balances were never derived from it.
              {...(t.kind === "deposit" &&
              t.status === "pending" &&
              Date.now() - t.createdAt > 60 * 60 * 1000
                ? { onDismiss: () => dismissDeposit.mutate(t.id.replace(/^d-/, "")) }
                : {})}
            />
          </FadeRise>
        ))}
      </AnimatePresence>

      {/* Secondary, opt-in: manual deposit address + the full asset/chain
          catalog (Solana/BTC and anything the wallet doesn't hold). */}
      <div className="overflow-hidden rounded-md border border-border">
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-muted hover:text-fg"
        >
          <span>Deposit manually · other assets &amp; chains</span>
          <ChevronDown
            size={14}
            className={cn("shrink-0 transition-transform", manualOpen && "rotate-180")}
          />
        </button>
        <AnimatedHeight>
          {manualOpen ? (
            <div className="space-y-3 border-t border-border p-3">
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
                      setPicked(true);
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
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Network</div>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {chains.map((chain) => {
                      const active = selectedChain?.chainId === chain.chainId;
                      return (
                        <button
                          key={chain.chainId}
                          type="button"
                          onClick={() => {
                            setChainChoice(chain.chainId);
                            setCustomAssetId(null);
                            setPicked(true);
                          }}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                            active
                              ? "border-accent/60 bg-accent/10"
                              : "border-border bg-surface-2 hover:border-border-strong",
                          )}
                        >
                          <ChainIcon
                            chainId={chain.chainId}
                            name={chain.chainName}
                            size={20}
                            className="shrink-0"
                          />
                          <span className="block min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                            {chain.chainName}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {selectedAsset && bridgeAddress ? (
                <div className="rounded-md border border-border bg-surface p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] uppercase tracking-wide text-muted">
                        Deposit {selectedAsset.token.symbol} on {selectedAsset.chainName}
                      </span>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="flex-1 break-all font-mono text-[12px] leading-relaxed text-fg">
                          {bridgeAddress}
                        </span>
                        <CopyButton text={bridgeAddress} />
                      </div>
                      <p className="mt-1.5 text-[11px] leading-snug text-muted">
                        Send from any wallet or exchange — it converts automatically and lands in
                        your balance in a few minutes. This address is yours and won&apos;t change.
                      </p>
                    </div>
                    <QrBadge value={bridgeAddress} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </AnimatedHeight>
      </div>

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

/** Compact token amount: 2 dp for ≥1, 4 dp for smaller balances. */
const formatAmount = (amount: number): string =>
  amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);

/**
 * The connected wallet's deposit-ready balances (asset · chain · amount · USD),
 * sorted by value — the primary "pick what you have" list. Handles the
 * loading / not-connected / nothing-held states with a nudge to the manual
 * deposit disclosure.
 */
function HoldingsList({
  wallet,
  selectedAssetId,
  onPick,
  onManual,
}: {
  wallet: WalletHoldingsResult;
  selectedAssetId: string | null;
  onPick: (holding: WalletHolding) => void;
  onManual: () => void;
}) {
  if (wallet.isLoading) return <Spinner label="Reading your wallet…" />;

  if (!wallet.isConnected) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
        Connect your wallet to see the assets you can deposit.
      </p>
    );
  }

  if (wallet.holdings.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-5 text-center">
        <p className="text-[12px] text-muted">
          No deposit-ready balances found in your wallet on the supported chains.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onManual}>
          Deposit manually
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">Your assets</div>
      {wallet.holdings.map((h) => {
        const active = selectedAssetId === h.asset.id;
        return (
          <button
            key={h.key}
            type="button"
            onClick={() => onPick(h)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
              active
                ? "border-accent/60 bg-accent/10"
                : "border-border bg-surface-2 hover:border-border-strong",
            )}
          >
            <ChainIcon chainId={h.chainId} name={h.chainName} size={26} className="shrink-0" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px] font-semibold text-fg">{h.group}</span>
              <span className="tabular block truncate text-[11px] text-muted">
                {formatAmount(h.amount)} {h.group} · {h.chainName}
              </span>
            </span>
            <span className="tabular shrink-0 text-right text-[13px] font-semibold text-fg">
              {h.usd != null ? `$${h.usd.toFixed(2)}` : "—"}
            </span>
          </button>
        );
      })}
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
            <div className="space-y-2">
              <AmountPresets
                value={amount}
                onChange={setAmount}
                max={
                  connectedBalance.data ? Number(formatUnits(connectedBalance.data.value, 6)) : null
                }
                placeholder="Amount (USDC)"
              />
              <Button
                size="sm"
                variant="primary"
                className="w-full"
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
