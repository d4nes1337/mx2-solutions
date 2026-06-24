"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
  FEED_LIMIT,
  hottestScore,
  newVolumeScore,
  sortEventsByScore,
} from "./feeds";
import type {
  CreateRuleRequest,
  EvaluateNowResponse,
  EventsResponse,
  FeatureFlags,
  HistoryResponse,
  MarketDetail,
  OrderbookResponse,
  OrderPreviewRequest,
  OrderPreviewResponse,
  PnlResponse,
  PositionsResponse,
  PricesHistoryResponse,
  RuleRow,
  RulesResponse,
  SetupCredentialsRequest,
  SetupCredentialsResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TradeStatus,
  TriggerDetailResponse,
  TriggersResponse,
} from "./types";

// ── Public read-only data ────────────────────────────────────────────────────

const FEED_BASE = `/api/events?limit=${FEED_LIMIT}&active=true&closed=false`;

export function useLatestFeed() {
  return useQuery({
    queryKey: ["feed", "latest"],
    queryFn: () =>
      api.get<EventsResponse>(`${FEED_BASE}&order=createdAt&ascending=false`),
    staleTime: 30_000,
  });
}

export function useVolumeWeekFeed() {
  return useQuery({
    queryKey: ["feed", "volumeWeek"],
    queryFn: () =>
      api.get<EventsResponse>(`${FEED_BASE}&order=volume1wk&ascending=false`),
    staleTime: 60_000,
  });
}

export function useHottestFeed() {
  return useQuery({
    queryKey: ["feed", "hottest"],
    queryFn: async () => {
      const res = await api.get<EventsResponse>(
        `/api/events?limit=60&active=true&closed=false`,
      );
      return {
        ...res,
        events: sortEventsByScore(res.events, hottestScore),
        count: Math.min(res.events.length, FEED_LIMIT),
      };
    },
    staleTime: 60_000,
  });
}

/** Placeholder until user favorites are persisted server-side. */
export function useFavoritesDefaultFeed() {
  return useQuery({
    queryKey: ["feed", "favoritesDefault"],
    queryFn: async () => {
      const res = await api.get<EventsResponse>(
        `/api/events?limit=60&active=true&closed=false&order=createdAt&ascending=false`,
      );
      return {
        ...res,
        events: sortEventsByScore(res.events, newVolumeScore),
        count: Math.min(res.events.length, FEED_LIMIT),
      };
    },
    staleTime: 60_000,
  });
}

/** @deprecated Use feed-specific hooks on the home page. */
export function useEvents() {
  return useLatestFeed();
}

export function useMarket(id: string) {
  return useQuery({
    queryKey: ["market", id],
    queryFn: () => api.get<MarketDetail>(`/api/markets/${id}`),
    enabled: Boolean(id),
  });
}

export function useOrderbook(id: string, outcome: number) {
  return useQuery({
    queryKey: ["orderbook", id, outcome],
    queryFn: () => api.get<OrderbookResponse>(`/api/markets/${id}/orderbook?outcome=${outcome}`),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });
}

export function usePricesHistory(id: string) {
  return useQuery({
    queryKey: ["prices-history", id],
    queryFn: () => api.get<PricesHistoryResponse>(`/api/markets/${id}/prices-history`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useFeatureFlags() {
  return useQuery({
    queryKey: ["feature-flags"],
    queryFn: () => api.get<FeatureFlags>("/api/feature-flags"),
    staleTime: 5 * 60_000,
  });
}

export function useTradeStatus() {
  return useQuery({
    queryKey: ["trade-status"],
    queryFn: () => api.get<TradeStatus>("/api/trade/status"),
    staleTime: 60_000,
  });
}

// ── Authenticated portfolio ──────────────────────────────────────────────────
// The Data API keys off the deposit/proxy wallet, so callers may pass an
// optional proxyWallet override (see PnL limitations text).

const proxyQuery = (proxyWallet?: string) =>
  proxyWallet ? `?proxyWallet=${encodeURIComponent(proxyWallet)}` : "";

export function usePositions(enabled: boolean, proxyWallet?: string) {
  return useQuery({
    queryKey: ["positions", proxyWallet ?? ""],
    queryFn: () => api.get<PositionsResponse>(`/api/profile/positions${proxyQuery(proxyWallet)}`),
    enabled,
  });
}

export function useHistory(enabled: boolean, proxyWallet?: string) {
  return useQuery({
    queryKey: ["history", proxyWallet ?? ""],
    queryFn: () =>
      api.get<HistoryResponse>(
        `/api/profile/history${proxyQuery(proxyWallet)}${proxyWallet ? "&" : "?"}limit=25`,
      ),
    enabled,
  });
}

export function usePnl(enabled: boolean, proxyWallet?: string) {
  return useQuery({
    queryKey: ["pnl", proxyWallet ?? ""],
    queryFn: () => api.get<PnlResponse>(`/api/profile/pnl${proxyQuery(proxyWallet)}`),
    enabled,
  });
}

// ── Order preview (safe; no trading flag required) ───────────────────────────

export function useOrderPreview() {
  return useMutation({
    mutationFn: (req: OrderPreviewRequest) =>
      api.post<OrderPreviewResponse>("/api/trade/orders/preview", req),
  });
}

// ── CLOB credential setup (one-time per user; L1-signature → derived L2 key) ──

export function useSetupCredentials() {
  return useMutation({
    mutationFn: (req: SetupCredentialsRequest) =>
      api.post<SetupCredentialsResponse>("/api/trade/credentials/setup", req),
  });
}

// ── Order submit / cancel (gated by the live-trading flag on the backend) ────

export function useSubmitOrder() {
  return useMutation({
    mutationFn: (req: SubmitOrderRequest) =>
      api.post<SubmitOrderResponse>("/api/trade/orders", req),
  });
}

export function useCancelOrder() {
  return useMutation({
    mutationFn: (clobOrderId: string) =>
      api.del<{ ok: boolean; clobOrderId: string }>(`/api/trade/orders/${clobOrderId}`),
  });
}

// ── Conditional rules (shadow / alert / manual-confirm) ──────────────────────

export function useRules() {
  return useQuery({
    queryKey: ["rules"],
    queryFn: () => api.get<RulesResponse>("/api/rules"),
    refetchInterval: 4_000,
  });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRuleRequest) => api.post<RuleRow>("/api/rules", req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useRuleControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "cancel";
    }): Promise<void> => {
      if (action === "cancel") await api.del<{ ok: boolean }>(`/api/rules/${id}`);
      else await api.post<RuleRow>(`/api/rules/${id}/${action}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

/** Read-only "would this trigger right now?" against the latest snapshot. */
export function useRuleEvaluateNow(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["rule-eval", id],
    queryFn: () => api.get<EvaluateNowResponse>(`/api/rules/${id}/evaluate-now`),
    enabled,
    refetchInterval: 3_000,
  });
}

export function useTriggers() {
  return useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.get<TriggersResponse>("/api/rules/triggers"),
    refetchInterval: 4_000,
  });
}

export function useTriggerDetail(id: string | null) {
  return useQuery({
    queryKey: ["trigger", id],
    queryFn: () => api.get<TriggerDetailResponse>(`/api/rules/triggers/${id}`),
    enabled: Boolean(id),
    refetchInterval: 3_000,
  });
}

export function useConfirmTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, orderIntentId }: { id: string; orderIntentId?: string }) =>
      api.post<{ ok: boolean; status?: string }>(`/api/rules/triggers/${id}/confirm`, {
        orderIntentId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}

export function useDismissTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean }>(`/api/rules/triggers/${id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
}
