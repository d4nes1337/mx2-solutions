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
  /** Freeform organization labels (lowercased). */
  tags: string[];
  /** Set when soft-hidden; only terminal strategies can be archived. */
  archivedAt: string | null;
  /** Versioned-edit linkage: the strategy this one replaced / was replaced by. */
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  definitionV2: StrategyDefinition;
  /** Detail endpoint only: per-strategy auto kill switch state (W8). */
  autoDisabled?: boolean;
  /**
   * True when the rule asks for auto execution but the server cannot deliver
   * it (live execution disabled) — the trigger will wait for manual confirm.
   */
  autoDegraded?: boolean;
  degradedReason?: string | null;
}

export interface AutoReadiness {
  autoExecutionEnabled: boolean;
  blockers: { code: string; detail: string }[];
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
  /** null when the draft has no bound conditions (freshness-only probe). */
  root: ExprResultNode | null;
  staleTokenIds: string[];
  markets: MarketFreshness[];
  evaluatedAt: string;
}

export interface StrategyEvaluation extends Omit<DraftEvaluation, "evaluatedAt"> {
  strategyId: string;
  status: string;
  holdsForMs: number;
  maxDataAgeMs: number;
  trueSince: string | null;
  triggerCount: number;
  cooldownUntil: string | null;
}

// ── Timeline (GET /api/smart-orders/:id/timeline) ───────────────────────────

export interface TimelineEvent {
  id: string;
  at: string;
  action: string;
  metadata: Record<string, unknown>;
}

export interface TimelineTrigger {
  id: string;
  triggeredAt: string;
  status: string;
  reasonCodes: string[];
  orderIntentId: string | null;
}

export interface TimelineOrder {
  id: string;
  createdAt: string;
  status: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  orderType: string;
  clobOrderId: string | null;
  filledSize: string;
  avgFillPrice: string | null;
  tokenId: string;
  conditionId: string;
  errorMessage: string | null;
}

export interface StrategyTimeline {
  strategyId: string;
  status: string;
  events: TimelineEvent[];
  triggers: TimelineTrigger[];
  orders: TimelineOrder[];
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
  /** Sub-market label inside a multi-market event ("Over 2.5", a candidate). */
  groupItemTitle: string;
  bestBid: string;
  bestAsk: string;
  active: boolean;
  closed: boolean;
  sportsMarketType: string | null;
}

/** Event-granularity search hit: the event plus its ordered sub-markets. */
export interface EventSearchResult {
  eventId: string;
  title: string;
  image: string;
  endDate: string | null;
  negRisk: boolean;
  markets: MarketSearchResult[];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useStrategies(signedIn: boolean, includeArchived = false) {
  return useQuery({
    queryKey: ["smart-orders", { includeArchived }],
    queryFn: () =>
      api.get<{ strategies: StrategyRow[] }>(
        `/api/smart-orders${includeArchived ? "?includeArchived=1" : ""}`,
      ),
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

/** Why auto wouldn't execute right now (server flags + account setup). */
export function useAutoReadiness(signedIn: boolean) {
  return useQuery({
    queryKey: ["smart-orders", "auto-readiness"],
    queryFn: () => api.get<AutoReadiness>("/api/smart-orders/auto-readiness"),
    enabled: signedIn,
    refetchInterval: 60_000,
    staleTime: 30_000,
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

/** Activity feed: engine state churn + triggers + linked orders with fills. */
export function useStrategyTimeline(id: string | null) {
  return useQuery({
    queryKey: ["smart-orders", id, "timeline"],
    queryFn: () => api.get<StrategyTimeline>(`/api/smart-orders/${id}/timeline`),
    enabled: Boolean(id),
    refetchInterval: POLL.ruleTimeline,
    placeholderData: (prev) => prev,
  });
}

/** Per-strategy auto kill switch (W8): disarm blocks auto-submission only. */
export function useStrategyDisarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "disarm" | "rearm" }) =>
      api.post<{ ok: boolean; autoDisabled: boolean }>(`/api/smart-orders/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-orders"] }),
  });
}

export function useCreateStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      def: StrategyDefinition & { expiresAt?: string | null; supersedes?: string },
    ) => {
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
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "cancel" | "archive" | "unarchive";
    }) => api.post<StrategyRow>(`/api/smart-orders/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-orders"] }),
  });
}

/** Replace a strategy's freeform tags (≤10, 1–24 chars — validated server-side). */
export function useSetStrategyTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      api.patch<StrategyRow>(`/api/smart-orders/${id}/tags`, { tags }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-orders"] }),
  });
}

/**
 * Public draft evaluation for the builder playground. `revision` keys the
 * cache to the doc's semantic version; polling keeps the verdict live.
 * `extraTokenIds` (order-action / watched markets outside the expression)
 * are keyed separately — watched markets don't bump the revision.
 */
export function useDraftEvaluation(
  expr: ExprNode | null,
  maxDataAgeMs: number,
  extraTokenIds: string[],
  revision: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["draft-eval", revision, extraTokenIds.join(",")],
    queryFn: () =>
      api.post<DraftEvaluation>("/api/smart-orders/evaluate-draft", {
        expr,
        maxDataAgeMs,
        extraTokenIds,
      }),
    enabled: enabled && (expr !== null || extraTokenIds.length > 0),
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

/** Full event (ordered sub-markets) — the event page. */
export function useEventMarkets(eventId: string | null) {
  return useQuery({
    queryKey: ["event-markets", eventId],
    queryFn: () => api.get<EventSearchResult>(`/api/events/${eventId}/markets`),
    enabled: Boolean(eventId),
    staleTime: 30_000,
  });
}

/** Parent-event siblings for a token — "Also in this event" surfaces. */
export function useMarketSiblings(tokenId: string | null) {
  return useQuery({
    queryKey: ["market-siblings", tokenId],
    queryFn: () =>
      api.get<{ event: EventSearchResult | null }>(
        `/api/markets/siblings?tokenId=${encodeURIComponent(tokenId!)}`,
      ),
    enabled: Boolean(tokenId),
    staleTime: 30_000,
  });
}

/**
 * Event-grouped search (Markets tab, builder picker): every hit carries its
 * sub-markets — totals/spreads in a match, candidates in an election.
 */
export function useGroupedMarketSearch(q: string) {
  const query = useDebouncedValue(q.trim(), 300);
  return useQuery({
    queryKey: ["market-search-grouped", query],
    queryFn: () =>
      api.get<{ results: EventSearchResult[] }>(
        `/api/markets/search/grouped?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
