"use client";

/**
 * Smart Orders data layer (v2 API). Kept beside the builder libs so the whole
 * feature reads as one module; reuses the shared api wrapper + POLL cadences.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { POLL } from "../queries";
import { useDebouncedValue } from "../use-debounced-value";
import type { ExprNode, ExprResultNode, StrategyDefinition } from "@mx2/rules";

// ── Response shapes (mirror apps/api/src/routes/smart-orders.ts) ────────────

export interface StrategyRow {
  id: string;
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  status: string;
  version: number;
  name: string | null;
  templateId: string | null;
  tokenIds: string[];
  triggerCount: number;
  cooldownUntil: string | null;
  trueSince: string | null;
  expiresAt: string | null;
  lastEvaluatedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  definitionV2: StrategyDefinition;
}

export interface MarketFreshness {
  tokenId: string;
  hasData: boolean;
  dataAgeMs: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface DraftEvaluation {
  satisfied: boolean;
  root: ExprResultNode;
  staleTokenIds: string[];
  markets: MarketFreshness[];
  evaluatedAt: string;
}

export interface StrategyEvaluation extends Omit<DraftEvaluation, "evaluatedAt"> {
  strategyId: string;
  status: string;
  holdsForMs: number;
  trueSince: string | null;
  triggerCount: number;
  cooldownUntil: string | null;
}

export interface MarketSearchResult {
  eventId: string;
  marketId: string;
  title: string;
  eventTitle: string;
  image: string;
  conditionId: string;
  tokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  endDate: string | null;
  negRisk: boolean;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useStrategies(signedIn: boolean) {
  return useQuery({
    queryKey: ["smart-orders"],
    queryFn: () => api.get<{ strategies: StrategyRow[] }>("/api/smart-orders"),
    enabled: signedIn,
    refetchInterval: POLL.rules,
  });
}

export function useStrategy(id: string | null) {
  return useQuery({
    queryKey: ["smart-orders", id],
    queryFn: () => api.get<StrategyRow>(`/api/smart-orders/${id}`),
    enabled: Boolean(id),
  });
}

export function useStrategyEvaluation(id: string | null) {
  return useQuery({
    queryKey: ["smart-orders", id, "eval"],
    queryFn: () => api.get<StrategyEvaluation>(`/api/smart-orders/${id}/evaluate-now`),
    enabled: Boolean(id),
    refetchInterval: POLL.ruleEval,
  });
}

export function useCreateStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (def: StrategyDefinition & { expiresAt?: string | null }) => {
      const { expiresAtMs, version, ...rest } = def;
      void version;
      return api.post<StrategyRow>("/api/smart-orders", {
        ...rest,
        expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-orders"] }),
  });
}

export function useStrategyControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "cancel" }) =>
      api.post<StrategyRow>(`/api/smart-orders/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-orders"] }),
  });
}

/**
 * Public draft evaluation for the builder playground. `revision` keys the
 * cache to the doc's semantic version; polling keeps the verdict live.
 */
export function useDraftEvaluation(
  expr: ExprNode | null,
  maxDataAgeMs: number,
  revision: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["draft-eval", revision],
    queryFn: () =>
      api.post<DraftEvaluation>("/api/smart-orders/evaluate-draft", { expr, maxDataAgeMs }),
    enabled: enabled && expr !== null,
    refetchInterval: POLL.ruleEval,
    placeholderData: (prev) => prev,
  });
}

export function useMarketSearch(q: string) {
  // Debounced internally so every consumer gets keystroke-safe fetching.
  const query = useDebouncedValue(q.trim(), 250);
  return useQuery({
    queryKey: ["market-search", query],
    queryFn: () =>
      api.get<{ results: MarketSearchResult[] }>(
        `/api/markets/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });
}
