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
import { Check, ExternalLink, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Spinner, cn } from "@/components/ui";
import {
  useBridgeDepositAddresses,
  useDismissDeposit,
  useFundsAssets,
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
import { useChainTokenBalances } from "@/lib/use-chain-balances";
import { useActiveTransfers } from "@/lib/use-active-transfers";
import { useFundsUi } from "@/lib/funds-ui";
import { ChainIcon } from "@/components/wallet/ChainIcon";
import { AnimatePresence } from "motion/react";
import { FadeRise } from "@/components/motion/primitives";
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
  // Connected-wallet balances of this token per EVM chain — drives the
  // "you have funds here" ordering + highlight, Polymarket-style.
  const chainBalances = useChainTokenBalances(assetRows, activeGroup);
  const orderedChains = useMemo(
    () =>
      [...chains].sort(
        (a, b) =>
          Number(Boolean(chainBalances[b.chainId]?.hasBalance)) -
          Number(Boolean(chainBalances[a.chainId]?.hasBalance)),
      ),
    [chains, chainBalances],
  );
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

      {orderedChains.length > 1 ? (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Network</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {orderedChains.map((chain) => {
              const bal = chainBalances[chain.chainId];
              const active = selectedChain?.chainId === chain.chainId;
              return (
                <button
                  key={chain.chainId}
                  type="button"
                  onClick={() => {
                    setChainChoice(chain.chainId);
                    setCustomAssetId(null);
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
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12px] font-medium text-fg">
                      {chain.chainName}
                    </span>
                    {bal?.hasBalance ? (
                      <span className="tabular block text-[10px] text-pos">
                        {bal.label} {activeGroup}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
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
                balance in a few minutes. This address is yours and won&apos;t change.
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
            <div className="space-y-2">
              <AmountPresets
                value={amount}
                onChange={setAmount}
                max={
                  connectedBalance.data
                    ? Number(formatUnits(connectedBalance.data.value, 6))
                    : null
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
