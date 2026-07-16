"use client";

/**
 * Farming cockpit data hooks: the rewards scanner (public, flag-gated) and
 * per-rule quoting-session state/controls (authed).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface ScannerMarket {
  conditionId: string;
  title: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  ratePerDayUsd: number;
  minSize: number | null;
  maxSpreadCents: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadCents: number | null;
  liquidityUsd: number | null;
  negRisk: boolean;
  spreadHeadroomCents: number | null;
}

export interface ScannerResponse {
  markets: ScannerMarket[];
  fetchedAt: string;
}

export interface QuoteSession {
  id: string;
  ruleId: string;
  walletAddress: string;
  mode: "shadow" | "confirm" | "live";
  status: "idle" | "quoting" | "halted";
  haltedReason: string | null;
  inventoryYes: string;
  inventoryNo: string;
  capitalCommittedUsd: string;
  realizedPnlUsd: string;
  dailyLossUsd: string;
  rewardsAccruedUsd: string;
  lastCycleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteEvent {
  id: string;
  sessionId: string;
  ruleId: string;
  type: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function useRewardsScanner(enabled: boolean) {
  return useQuery({
    queryKey: ["rewards-scanner"],
    queryFn: () => api.get<ScannerResponse>("/api/rewards/scanner"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useQuoterSession(ruleId: string) {
  return useQuery({
    queryKey: ["quoter-session", ruleId],
    queryFn: () =>
      api.get<{ session: QuoteSession; recentEvents: QuoteEvent[] }>(
        `/api/quoter/sessions/${encodeURIComponent(ruleId)}`,
      ),
    enabled: Boolean(ruleId),
    refetchInterval: 5_000,
  });
}

export function useQuoterControl(ruleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: "halt" | "resume" } | { action: "mode"; mode: string }) =>
      input.action === "mode"
        ? api.post(`/api/quoter/sessions/${encodeURIComponent(ruleId)}/mode`, {
            mode: input.mode,
          })
        : api.post(`/api/quoter/sessions/${encodeURIComponent(ruleId)}/${input.action}`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quoter-session", ruleId] }),
  });
}
