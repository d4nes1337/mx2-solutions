"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { FEED_LIMIT, hottestScore, newVolumeScore, sortEventsByScore } from "./feeds";
import type {
  CreateRuleRequest,
  EquityHistoryResponse,
  EquityWindow,
  EvaluateNowResponse,
  EventsResponse,
  FeatureFlags,
  HomeFeedResponse,
  HistoryResponse,
  HistoryTypeFilter,
  MarketDetail,
  MarketEconomicsResponse,
  MarketHoldersResponse,
  MarketScenariosResponse,
  MarketTradesResponse,
  OpenOrdersResponse,
  OrderbookResponse,
  PortfolioOverviewResponse,
  PnlResponse,
  PositionsResponse,
  PricesHistoryResponse,
  TokenPricesHistoryResponse,
  ShowcasesResponse,
  RuleRow,
  RulesResponse,
  SetupCredentialsRequest,
  SetupCredentialsResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TradingAccountsResponse,
  TradingAccountResponse,
  TradingWalletActivationResponse,
  TradingWalletBalanceResponse,
  TradingWalletProvisionResponse,
  TradingWalletReissueResponse,
  TradingWalletStatusResponse,
  TradeStatus,
  TriggerDetailResponse,
  TriggersResponse,
  UpsertExternalTradingAccountRequest,
} from "./types";

/**
 * Central poll cadences (ms). Tightened for a live-terminal feel. These are the
 * first knob to turn if the API/DB sees load pressure — raise the hot ones
 * (orderbook, portfolio) before touching architecture. See RISK_REGISTER
 * (poll-load).
 */
export const POLL = {
  homeFeed: 60_000,
  orderbook: 2_000, // was 5_000
  pricesHistory: 10_000, // live-chart default; was 15_000 at call sites
  tradingWallet: 20_000,
  portfolio: 10_000, // was 30_000
  openOrders: 15_000,
  rules: 4_000,
  ruleEval: 3_000,
  triggers: 4_000,
  triggerDetail: 3_000,
  marketTrades: 10_000,
} as const;

// ── Public read-only data ────────────────────────────────────────────────────

const FEED_BASE = `/api/events?limit=${FEED_LIMIT}&active=true&closed=false`;

export function useHomeFeed() {
  return useQuery({
    queryKey: ["feed", "home"],
    queryFn: () => api.get<HomeFeedResponse>("/api/feed/home"),
    staleTime: 30_000,
    refetchInterval: POLL.homeFeed,
  });
}

export function useLatestFeed() {
  return useQuery({
    queryKey: ["feed", "latest"],
    queryFn: () => api.get<EventsResponse>(`${FEED_BASE}&order=createdAt&ascending=false`),
    staleTime: 30_000,
  });
}

export function useVolumeWeekFeed() {
  return useQuery({
    queryKey: ["feed", "volumeWeek"],
    queryFn: () => api.get<EventsResponse>(`${FEED_BASE}&order=volume1wk&ascending=false`),
    staleTime: 60_000,
  });
}

export function useHottestFeed() {
  return useQuery({
    queryKey: ["feed", "hottest"],
    queryFn: async () => {
      const res = await api.get<EventsResponse>(`/api/events?limit=60&active=true&closed=false`);
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
    refetchInterval: POLL.orderbook,
  });
}

/**
 * Order book keyed by the exact CLOB token (the builder knows tokenIds, not
 * Gamma market ids). Uses the token-keyed public route; a persistent failure
 * stops the poll instead of hammering a doomed request every 2s.
 */
export function useOrderbookByToken(tokenId: string | null) {
  return useQuery({
    queryKey: ["orderbook-token", tokenId],
    queryFn: () =>
      api.get<OrderbookResponse>(`/api/markets/orderbook?tokenId=${encodeURIComponent(tokenId!)}`),
    enabled: Boolean(tokenId),
    retry: 1,
    refetchInterval: (query) => (query.state.error ? false : POLL.orderbook),
  });
}

export function usePricesHistory(
  id: string,
  opts?: { interval?: string; outcome?: number; enabled?: boolean; refetchInterval?: number },
) {
  const interval = opts?.interval ?? "1w";
  const outcome = opts?.outcome ?? 0;
  return useQuery({
    queryKey: ["prices-history", id, interval, outcome],
    queryFn: () =>
      api.get<PricesHistoryResponse>(
        `/api/markets/${id}/prices-history?interval=${encodeURIComponent(interval)}&outcome=${outcome}`,
      ),
    enabled: Boolean(id) && (opts?.enabled ?? true),
    staleTime: 30_000,
    refetchInterval: opts?.refetchInterval,
  });
}

/** Recent public trades in a market (Data API tape, most recent first). */
export function useMarketTrades(id: string, limit = 25) {
  return useQuery({
    queryKey: ["market-trades", id, limit],
    queryFn: () => api.get<MarketTradesResponse>(`/api/markets/${id}/trades?limit=${limit}`),
    enabled: Boolean(id),
    refetchInterval: POLL.marketTrades,
    staleTime: 10_000,
  });
}

/** Top holders per outcome token. Slow-moving — no polling. */
export function useMarketHolders(id: string, limit = 8) {
  return useQuery({
    queryKey: ["market-holders", id, limit],
    queryFn: () => api.get<MarketHoldersResponse>(`/api/markets/${id}/holders?limit=${limit}`),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

/** Per-market fee schedule + rewards config (server-cached 5 min). */
export function useMarketEconomics(conditionId: string) {
  return useQuery({
    queryKey: ["market-economics", conditionId],
    queryFn: () =>
      api.get<MarketEconomicsResponse>(`/api/markets/${encodeURIComponent(conditionId)}/economics`),
    enabled: Boolean(conditionId),
    staleTime: 5 * 60_000,
  });
}

/** Backtested "how you could enter this market" scenarios (server-cached 15 min). */
export function useMarketScenarios(id: string, outcome: number, enabled = true) {
  return useQuery({
    queryKey: ["market-scenarios", id, outcome],
    queryFn: () =>
      api.get<MarketScenariosResponse>(`/api/markets/${id}/scenarios?outcome=${outcome}`),
    enabled: Boolean(id) && enabled,
    staleTime: 5 * 60_000,
  });
}

/** Backtested "would have paid off" showcases (server-cached 15 min). */
export function useShowcases(enabled = true) {
  return useQuery({
    queryKey: ["showcases"],
    queryFn: () => api.get<ShowcasesResponse>("/api/showcases"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** 30-day history keyed directly by CLOB token id (builder projection panel). */
export function useTokenPricesHistory(tokenId: string | null, interval = "1m") {
  return useQuery({
    queryKey: ["token-prices-history", tokenId, interval],
    queryFn: () =>
      api.get<TokenPricesHistoryResponse>(
        `/api/markets/prices-history?tokenId=${encodeURIComponent(tokenId!)}&interval=${encodeURIComponent(interval)}`,
      ),
    enabled: Boolean(tokenId),
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

export function useTradingAccounts(enabled = true) {
  return useQuery({
    queryKey: ["trading-accounts"],
    queryFn: () => api.get<TradingAccountsResponse>("/api/trading-accounts"),
    enabled,
    staleTime: 30_000,
  });
}

export function useSetPrimaryTradingAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<TradingAccountResponse>(`/api/trading-accounts/${id}/primary`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
    },
  });
}

export function useArchiveTradingAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean; id: string }>(`/api/trading-accounts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
    },
  });
}

export function useUpsertExternalTradingAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpsertExternalTradingAccountRequest) =>
      api.post<TradingAccountResponse>("/api/trading-accounts/external", req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
    },
  });
}

export function useProvisionTradingWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TradingWalletProvisionResponse>("/api/trading-wallet/provision"),
    onSuccess: () => {
      // Provisioning can also RESTORE an archived account — refresh everything
      // that renders wallet state so the card reappears immediately.
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-health"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-balance"] });
    },
  });
}

export function useActivateDepositWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<TradingWalletActivationResponse>("/api/trading-wallet/activate-deposit-wallet"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
    },
  });
}

export function useTradingWallet(enabled = true) {
  return useQuery({
    queryKey: ["trading-wallet"],
    queryFn: () => api.get<TradingWalletStatusResponse>("/api/trading-wallet"),
    enabled,
    staleTime: 15_000,
    refetchInterval: POLL.tradingWallet,
  });
}

export function useBootstrapAllowances() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; status: string }>("/api/trading-wallet/bootstrap-allowances"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
    },
  });
}

/** Provider-verified wallet health (one Privy round-trip; no polling). */
export function useTradingWalletHealth(enabled = true) {
  return useQuery({
    queryKey: ["trading-wallet-health"],
    queryFn: () => api.get<TradingWalletStatusResponse>("/api/trading-wallet?verify=1"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Repair path for a provider-side-deleted wallet (409s if it's still alive). */
export function useReissueTradingWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TradingWalletReissueResponse>("/api/trading-wallet/reissue"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-health"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-balance"] });
    },
  });
}

/** On-chain USDC.e balances for the deposit wallet + signer EOA. */
export function useTradingWalletBalance(enabled = true) {
  return useQuery({
    queryKey: ["trading-wallet-balance"],
    queryFn: () => api.get<TradingWalletBalanceResponse>("/api/trading-wallet/balance"),
    enabled,
    staleTime: 30_000,
    retry: false, // 400/503 when not provisioned or RPC unset — show nothing.
  });
}

// ── Authenticated portfolio ──────────────────────────────────────────────────
// The Data API keys off the deposit/proxy wallet, so callers may pass an
// optional proxyWallet override (see PnL limitations text).

const proxyQuery = (proxyWallet?: string) =>
  proxyWallet ? `?proxyWallet=${encodeURIComponent(proxyWallet)}` : "";

const proxyAmp = (proxyWallet?: string) => (proxyWallet ? "&" : "?");

export function usePortfolioOverview(enabled: boolean, proxyWallet?: string) {
  return useQuery({
    queryKey: ["portfolio-overview", proxyWallet ?? ""],
    queryFn: () =>
      api.get<PortfolioOverviewResponse>(`/api/profile/overview${proxyQuery(proxyWallet)}`),
    enabled,
    refetchInterval: POLL.portfolio,
  });
}

export function useEquityHistory(enabled: boolean, window: EquityWindow, proxyWallet?: string) {
  return useQuery({
    queryKey: ["equity-history", window, proxyWallet ?? ""],
    queryFn: () =>
      api.get<EquityHistoryResponse>(
        `/api/profile/equity-history${proxyQuery(proxyWallet)}${proxyAmp(proxyWallet)}window=${window}`,
      ),
    enabled,
    staleTime: 60_000,
  });
}

export function useOpenOrders(enabled: boolean) {
  return useQuery({
    queryKey: ["open-orders"],
    queryFn: () => api.get<OpenOrdersResponse>("/api/profile/open-orders"),
    enabled,
    refetchInterval: POLL.openOrders,
  });
}

export function usePositions(enabled: boolean, proxyWallet?: string) {
  return useQuery({
    queryKey: ["positions", proxyWallet ?? ""],
    queryFn: () => api.get<PositionsResponse>(`/api/profile/positions${proxyQuery(proxyWallet)}`),
    enabled,
  });
}

export function useHistory(
  enabled: boolean,
  proxyWallet?: string,
  opts?: { limit?: number; offset?: number; type?: HistoryTypeFilter },
) {
  const limit = opts?.limit ?? 25;
  const offset = opts?.offset ?? 0;
  const type = opts?.type ?? "all";
  return useQuery({
    queryKey: ["history", proxyWallet ?? "", limit, offset, type],
    queryFn: () => {
      const base = proxyWallet ? `?proxyWallet=${encodeURIComponent(proxyWallet)}` : "?";
      const sep = proxyWallet ? "&" : "";
      return api.get<HistoryResponse>(
        `/api/profile/history${base}${sep}limit=${limit}&offset=${offset}&type=${type}`,
      );
    },
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

// ── CLOB credential setup (one-time per user; L1-signature → derived L2 key) ──

export function useSetupCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SetupCredentialsRequest) =>
      api.post<SetupCredentialsResponse>("/api/trade/credentials/setup", req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
    },
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
    refetchInterval: POLL.rules,
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
    refetchInterval: POLL.ruleEval,
  });
}

export function useTriggers() {
  return useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.get<TriggersResponse>("/api/rules/triggers"),
    refetchInterval: POLL.triggers,
  });
}

export function useTriggerDetail(id: string | null) {
  return useQuery({
    queryKey: ["trigger", id],
    queryFn: () => api.get<TriggerDetailResponse>(`/api/rules/triggers/${id}`),
    enabled: Boolean(id),
    refetchInterval: POLL.triggerDetail,
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
