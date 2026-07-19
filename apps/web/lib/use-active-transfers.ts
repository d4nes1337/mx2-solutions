"use client";

/**
 * The live feed of money movement: merges withdrawals, bridge withdrawals,
 * bridge deposits, and the USDC.e→pUSD conversion into one newest-first list
 * of `ActiveTransfer`s. The Funds sheet tracker, the History tab, and the
 * global pending pill all consume this single hook, so their polling is
 * deduped by React Query and their view of a transfer can never disagree.
 *
 * `justCompleted` fires only for pending→success transitions OBSERVED this
 * session (tracked in the funds-ui store) — that is what triggers the
 * checkmark celebration and the pill's green flash without historical rows
 * celebrating on mount.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useBridgeDeposits,
  useFeatureFlags,
  useFundsAssets,
  useTradingWalletBalance,
  useWithdrawals,
} from "./queries";
import { useFundsUi } from "./funds-ui";
import { FUNDS_DEMO_ENABLED, useFundsDemo } from "./funds-demo";
import {
  bridgeWithdrawalToTransfer,
  conversionToTransfer,
  depositToTransfer,
  walletWithdrawalToTransfer,
  type ActiveTransfer,
} from "./transfers";
import type { FundsAsset } from "./types";

/** How long a fresh completion counts as "just completed" (celebration window). */
export const JUST_COMPLETED_MS = 6_000;
/** Ignore unconverted dust below this (mirrors the sheet's display threshold). */
const CONVERSION_MIN_USD = 0.009;

export interface UseActiveTransfersResult {
  /** Every known transfer, newest first (History renders this). */
  transfers: ActiveTransfer[];
  /** Non-terminal transfers, incl. the conversion pseudo-transfer. */
  active: ActiveTransfer[];
  hasActive: boolean;
  /** Transfers whose pending→success flip was observed < JUST_COMPLETED_MS ago. */
  justCompleted: ActiveTransfer[];
  /** First load of the underlying history queries. */
  isLoading: boolean;
}

export function useActiveTransfers(opts: {
  enabled: boolean;
  /** Fast-poll even before any row exists (deposit-address screen open). */
  watching?: boolean;
}): UseActiveTransfersResult {
  const { enabled } = opts;
  const watching = Boolean(opts.watching);

  const flags = useFeatureFlags();
  const bridgeEnabled = Boolean(flags.data?.bridgeFunding);
  const withdrawals = useWithdrawals(enabled);
  const deposits = useBridgeDeposits(enabled && bridgeEnabled, { watching });
  const assets = useFundsAssets(enabled && bridgeEnabled);
  const balance = useTradingWalletBalance(enabled, { watching });

  const recordState = useFundsUi((s) => s.recordState);
  const seenStates = useFundsUi((s) => s.seenStates);

  // ── Conversion pseudo-transfer lifecycle ───────────────────────────────────
  // "Pending" while USDC.e sits unconverted; when the balance we were watching
  // drops to ~0, that IS the completion signal (Polymarket converted it).
  const unconvertedUsd = balance.data?.depositWalletUnconvertedUsdc ?? 0;
  const [conversion, setConversion] = useState<{
    amountUsd: number;
    startedAt: number;
    completedAt: number | null;
  } | null>(null);
  const sawUnconverted = useRef(false);
  useEffect(() => {
    if (unconvertedUsd > CONVERSION_MIN_USD) {
      sawUnconverted.current = true;
      setConversion((c) => ({
        amountUsd: unconvertedUsd,
        startedAt: c?.startedAt ?? Date.now(),
        completedAt: null,
      }));
    } else if (sawUnconverted.current) {
      sawUnconverted.current = false;
      setConversion((c) => (c && c.completedAt === null ? { ...c, completedAt: Date.now() } : c));
    }
  }, [unconvertedUsd]);

  // Dev demo override (NEXT_PUBLIC_FUNDS_DEMO=1): fabricated transfers drive
  // the whole surface instead of the real queries.
  const demoTransfers = useFundsDemo((s) => s.transfers);

  const assetRows = assets.data?.assets;
  const transfers = useMemo(() => {
    if (FUNDS_DEMO_ENABLED && demoTransfers) {
      return [...demoTransfers].sort((a, b) => b.createdAt - a.createdAt);
    }
    const assetFor = (chainId: string, tokenAddress: string): FundsAsset | null =>
      assetRows?.find(
        (a) =>
          a.chainId === chainId && a.token.address.toLowerCase() === tokenAddress.toLowerCase(),
      ) ?? null;
    const rows: ActiveTransfer[] = [
      ...(withdrawals.data?.withdrawals ?? []).map(walletWithdrawalToTransfer),
      ...(withdrawals.data?.bridgeWithdrawals ?? []).map(bridgeWithdrawalToTransfer),
      ...(deposits.data?.deposits ?? []).map((d) =>
        depositToTransfer(d, assetFor(d.fromChainId, d.fromTokenAddress)),
      ),
    ];
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }, [withdrawals.data, deposits.data, assetRows, demoTransfers]);

  // Feed observed states into the session memory (store dedupes no-ops).
  useEffect(() => {
    for (const t of transfers) recordState(t.id, t.state, t.status === "success");
    if (conversion) {
      recordState(
        "conversion",
        conversion.completedAt === null ? "converting" : "completed",
        conversion.completedAt !== null,
      );
    }
  }, [transfers, conversion, recordState]);

  const isLoading = withdrawals.isLoading || deposits.isLoading;

  return useMemo(() => {
    const now = Date.now();
    const conversionTransfer =
      conversion && conversion.completedAt === null
        ? conversionToTransfer(conversion.amountUsd, { startedAt: conversion.startedAt })
        : conversion?.completedAt && now - conversion.completedAt < JUST_COMPLETED_MS
          ? conversionToTransfer(conversion.amountUsd, {
              startedAt: conversion.startedAt,
              completedAt: conversion.completedAt,
            })
          : null;

    const active = [
      ...(conversionTransfer && conversionTransfer.status === "pending"
        ? [conversionTransfer]
        : []),
      ...transfers.filter((t) => t.status === "pending"),
    ];
    const justCompleted = [
      ...(conversionTransfer && conversionTransfer.status === "success"
        ? [conversionTransfer]
        : []),
      ...transfers.filter((t) => {
        if (t.status !== "success") return false;
        const seen = seenStates[t.id];
        return Boolean(seen?.completedAt && now - seen.completedAt < JUST_COMPLETED_MS);
      }),
    ];
    return { transfers, active, hasActive: active.length > 0, justCompleted, isLoading };
  }, [transfers, conversion, seenStates, isLoading]);
}
