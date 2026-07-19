"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { FEED_LIMIT, hottestScore, newVolumeScore, sortEventsByScore } from "./feeds";
import {
  BRIDGE_WITHDRAWAL_TERMINAL_STATES,
  DEPOSIT_TERMINAL_STATES,
  WALLET_WITHDRAWAL_TERMINAL_STATES,
} from "./transfers";
import type {
  CreateRuleRequest,
  EquityHistoryResponse,
  EquityWindow,
  EvaluateNowResponse,
  EventsResponse,
  FeatureFlags,
  BridgeDepositItem,
  FundsAssetsResponse,
  FundsDepositAddressesResponse,
  FundsSavedAddressesResponse,
  FundsQuoteResponse,
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
  BridgeWithdrawalItem,
  WalletWithdrawalItem,
  WithdrawResponse,
  TradingWalletStatusResponse,
  TradeStatus,
  TriggerDetailResponse,
  TriggersResponse,
  UpsertExternalTradingAccountRequest,
  LinkCodeResponse,
  NotificationChannelItem,
  NotificationChannelsResponse,
  NotificationKind,
  SignLinkExchangeResponse,
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
  ruleTimeline: 5_000,
  triggers: 4_000,
  triggerDetail: 3_000,
  marketTrades: 10_000,
  /** Funds transfers with something in flight — near-live confirmations. */
  transfersActive: 4_000,
  /** Funds transfers with nothing pending. */
  transfersIdle: 60_000,
  /** While a link code is outstanding — catch the bot-side /start completing. */
  notificationChannelsLinking: 3_000,
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
      // Activation changes both the account status and the wallet snapshot —
      // refresh every wallet view so the card doesn't lag a poll cycle behind.
      void qc.invalidateQueries({ queryKey: ["trading-accounts"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-health"] });
      void qc.invalidateQueries({ queryKey: ["trading-wallet-balance"] });
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

/** Owner-only withdrawal: destination is always the session login wallet. */
export function useWithdraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { amountUsd: number; idempotencyKey: string; toChainId?: string }) =>
      api.post<WithdrawResponse>("/api/trading-wallet/withdraw", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trading-wallet-balance"] });
      void qc.invalidateQueries({ queryKey: ["withdrawals"] });
    },
  });
}

type WithdrawalsResponse = {
  withdrawals: WalletWithdrawalItem[];
  bridgeWithdrawals?: BridgeWithdrawalItem[];
};

const hasPendingWithdrawal = (data: WithdrawalsResponse | undefined): boolean =>
  Boolean(
    data &&
    (data.withdrawals.some((w) => !WALLET_WITHDRAWAL_TERMINAL_STATES.has(w.state)) ||
      data.bridgeWithdrawals?.some((w) => !BRIDGE_WITHDRAWAL_TERMINAL_STATES.has(w.state))),
  );

export function useWithdrawals(enabled = true) {
  return useQuery({
    queryKey: ["withdrawals"],
    queryFn: () => api.get<WithdrawalsResponse>("/api/trading-wallet/withdrawals"),
    enabled,
    staleTime: 3_000,
    // Adaptive: poll fast only while a withdrawal is actually in flight —
    // each fetch also refreshes relayer/bridge state server-side. Idle: no
    // polling at all (mutations invalidate the key).
    refetchInterval: (query) =>
      hasPendingWithdrawal(query.state.data) ? POLL.transfersActive : false,
  });
}

export function useFundsAssets(enabled = true) {
  return useQuery({
    queryKey: ["funds-assets"],
    queryFn: () => api.get<FundsAssetsResponse>("/api/funds/assets"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Saved bridge deposit addresses — reads our own store, never the Bridge. */
export function useSavedDepositAddresses(enabled = true) {
  return useQuery({
    queryKey: ["bridge-deposit-addresses"],
    queryFn: () => api.get<FundsSavedAddressesResponse>("/api/funds/deposit-addresses"),
    enabled,
    staleTime: 60 * 60_000, // addresses are stable per deposit wallet
  });
}

export function useBridgeDepositAddresses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<FundsDepositAddressesResponse>("/api/funds/deposit-addresses"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bridge-deposit-addresses"] });
    },
  });
}

/** Deposit-direction bridge quote (fees/ETA/min received). */
export function useBridgeQuote() {
  return useMutation({
    mutationFn: (input: {
      fromChainId: string;
      fromTokenAddress: string;
      fromAmountBaseUnit: string;
    }) => api.post<FundsQuoteResponse>("/api/funds/quote", input),
  });
}

/**
 * Tracked bridge deposits; refetches trigger a bounded live status pull
 * (the server skips addresses checked within the last 5s, so the fast
 * cadence — and multiple tabs — can't hammer the Bridge).
 * `watching` forces the fast cadence while the deposit-address screen is
 * visible: the user is likely mid-transfer even before the first row exists.
 */
export function useBridgeDeposits(enabled = true, opts?: { watching?: boolean }) {
  const watching = Boolean(opts?.watching);
  return useQuery({
    queryKey: ["bridge-deposits"],
    queryFn: () => api.get<{ deposits: BridgeDepositItem[] }>("/api/funds/deposits?refresh=1"),
    enabled,
    staleTime: 3_000,
    refetchInterval: (query) =>
      watching || query.state.data?.deposits.some((d) => !DEPOSIT_TERMINAL_STATES.has(d.state))
        ? POLL.transfersActive
        : POLL.transfersIdle,
  });
}

/**
 * On-chain USDC.e balances for the deposit wallet + signer EOA. Polls fast
 * while USDC.e sits unconverted (that balance dropping to zero is how the
 * UI observes "conversion complete") or while a caller is watching.
 */
export function useTradingWalletBalance(enabled = true, opts?: { watching?: boolean }) {
  const watching = Boolean(opts?.watching);
  return useQuery({
    queryKey: ["trading-wallet-balance"],
    queryFn: () => api.get<TradingWalletBalanceResponse>("/api/trading-wallet/balance"),
    enabled,
    staleTime: 3_000,
    retry: false, // 400/503 when not provisioned or RPC unset — show nothing.
    refetchInterval: (query) =>
      watching || (query.state.data?.depositWalletUnconvertedUsdc ?? 0) > 0.009
        ? POLL.transfersActive
        : false,
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

// ── Sign links (mobile trigger signing) ──────────────────────────────────────

/** Trade a single-use sign-link token for a trigger-scoped session cookie. */
export function useExchangeSignLink() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post<SignLinkExchangeResponse>("/api/auth/sign-link/exchange", { token }),
  });
}

/** Telegram Mini App login: signed initData → wallet-scoped session cookie. */
export function useTelegramMiniappAuth() {
  return useMutation({
    mutationFn: (initData: string) =>
      api.post<{ ok: boolean; walletAddress: string; expiresAt: string }>(
        "/api/auth/telegram-miniapp",
        { initData },
      ),
  });
}

// ── Notification channels (Telegram/Discord linking) ─────────────────────────

export function useNotificationChannels(enabled: boolean, linking = false) {
  return useQuery({
    queryKey: ["notification-channels"],
    queryFn: () => api.get<NotificationChannelsResponse>("/api/notifications/channels"),
    enabled,
    refetchInterval: linking ? POLL.notificationChannelsLinking : false,
  });
}

export function useCreateLinkCode() {
  return useMutation({
    mutationFn: (channel: "telegram" | "discord") =>
      api.post<LinkCodeResponse>("/api/notifications/link-code", { channel }),
  });
}

export function useUpdateChannelPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      preferences,
    }: {
      id: string;
      preferences: Partial<Record<NotificationKind, boolean>>;
    }) => api.patch<NotificationChannelItem>(`/api/notifications/channels/${id}`, { preferences }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-channels"] }),
  });
}

export function useUnlinkChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/notifications/channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-channels"] }),
  });
}

/** Mint the Discord OAuth authorize URL (state = single-use link code). */
export function useDiscordOauthUrl() {
  return useMutation({
    mutationFn: () =>
      api.get<{ url: string; guildInviteUrl: string | null }>(
        "/api/notifications/discord/oauth-url",
      ),
  });
}
