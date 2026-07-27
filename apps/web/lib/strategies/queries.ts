"use client";

/**
 * Strategies data layer (v2 API). Kept beside the builder libs so the whole
 * feature reads as one module; reuses the shared api wrapper + POLL cadences.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { POLL } from "../queries";
import { useDebouncedValue } from "../use-debounced-value";
import type { ExprNode, ExprResultNode, StrategyDefinition } from "@mx2/rules";

// ── Response shapes (mirror apps/api/src/routes/strategies.ts) ────────────

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
  /** User pin: starred strategies float to the top of their section. */
  starredAt: string | null;
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

// ── Dashboard overview (GET /api/strategies/overview) ─────────────────────

export interface OverviewLeaf {
  nodeId: string;
  kind: string;
  tokenId: string | null;
  satisfied: boolean;
  stale: boolean;
  rawDistance: number | null;
  normDistance: number;
  blockedBy: string | null;
}

export interface StrategyOverviewItem {
  id: string;
  /** Ascending = closer to firing; meaningful only when proximity is non-null. */
  rank: number;
  proximity: {
    /** Prob units to the binding threshold; null when gate-blocked or stale. */
    bindingDistance: number | null;
    bindingTokenId: string | null;
    drift: "approaching" | "retreating" | "flat" | null;
    dwellFraction: number | null;
    blockedBy: string[];
    leaves: OverviewLeaf[];
  } | null;
  /** Only for triggered order strategies awaiting a signature. */
  actionability: {
    kind: "ready" | "missed";
    stillHolds: boolean;
    triggerId: string | null;
    triggeredAt: string | null;
    priceAtTrigger: number | null;
    priceNow: number | null;
    edge: number | null;
    edgeUsd: number | null;
  } | null;
}

export interface OverviewResponse {
  generatedAt: string;
  strategies: StrategyOverviewItem[];
  /** Per-token compact price series (unix seconds, 0–1 price), shared. */
  sparklines: Record<string, { t: number; p: number }[]>;
  books: Record<string, { bestBid: number | null; bestAsk: number | null; stale: boolean }>;
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

// ── Timeline (GET /api/strategies/:id/timeline) ───────────────────────────

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
  /** Recurring-series slug ("btc-up-or-down-5m") when this is an instance. */
  seriesSlug: string | null;
  /** Series cadence ("5m", "15m", "hourly", "weekly"…) when known. */
  recurrence: string | null;
  startDate: string | null;
}

/** Event-granularity search hit: the event plus its ordered sub-markets. */
export interface EventSearchResult {
  eventId: string;
  title: string;
  image: string;
  endDate: string | null;
  negRisk: boolean;
  /** Recurring-series identity (null = one-off event). */
  seriesSlug: string | null;
  recurrence: string | null;
  startDate: string | null;
  markets: MarketSearchResult[];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useStrategies(signedIn: boolean, includeArchived = false) {
  return useQuery({
    queryKey: ["strategies", { includeArchived }],
    queryFn: () =>
      api.get<{ strategies: StrategyRow[] }>(
        `/api/strategies${includeArchived ? "?includeArchived=1" : ""}`,
      ),
    enabled: signedIn,
    refetchInterval: POLL.rules,
  });
}

export function useStrategy(id: string | null) {
  return useQuery({
    queryKey: ["strategies", id],
    queryFn: () => api.get<StrategyRow>(`/api/strategies/${id}`),
    enabled: Boolean(id),
  });
}

/** Batch dashboard state: proximity ranks, ready/missed, sparklines, books. */
export function useStrategiesOverview(signedIn: boolean) {
  return useQuery({
    queryKey: ["strategies", "overview"],
    queryFn: () => api.get<OverviewResponse>("/api/strategies/overview"),
    enabled: signedIn,
    refetchInterval: POLL.overview,
    placeholderData: (prev) => prev,
  });
}

/**
 * Pin/unpin on the dashboard — optimistic so the card jumps immediately; the
 * list cache is patched in place and rolled back if the server disagrees.
 */
export function useStarStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      api.patch<StrategyRow>(`/api/strategies/${id}/star`, { starred }),
    onMutate: async ({ id, starred }) => {
      await qc.cancelQueries({ queryKey: ["strategies"] });
      const patched = qc.getQueriesData<{ strategies: StrategyRow[] }>({
        queryKey: ["strategies"],
      });
      for (const [key, data] of patched) {
        if (!data || !Array.isArray(data.strategies)) continue;
        qc.setQueryData(key, {
          ...data,
          strategies: data.strategies.map((r) =>
            r.id === id ? { ...r, starredAt: starred ? new Date().toISOString() : null } : r,
          ),
        });
      }
      return { patched };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.patched ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });
}

/**
 * Rename a strategy. Only the label moves — the definition stays immutable, so
 * this is NOT a versioned edit and never re-arms the strategy. Optimistic so
 * the new name lands instantly in the list and the panel.
 */
export function useRenameStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<StrategyRow>(`/api/strategies/${id}/name`, { name }),
    onMutate: async ({ id, name }) => {
      await qc.cancelQueries({ queryKey: ["strategies"] });
      const next = name.trim() === "" ? null : name.trim();
      const patched = qc.getQueriesData<{ strategies: StrategyRow[] }>({
        queryKey: ["strategies"],
      });
      for (const [key, data] of patched) {
        if (!data || !Array.isArray(data.strategies)) continue;
        qc.setQueryData(key, {
          ...data,
          strategies: data.strategies.map((r) => (r.id === id ? { ...r, name: next } : r)),
        });
      }
      const detail = qc.getQueryData<StrategyRow>(["strategies", id]);
      if (detail) qc.setQueryData(["strategies", id], { ...detail, name: next });
      return { patched, detail };
    },
    onError: (_err, vars, ctx) => {
      for (const [key, data] of ctx?.patched ?? []) qc.setQueryData(key, data);
      if (ctx?.detail) qc.setQueryData(["strategies", vars.id], ctx.detail);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });
}

/** Why auto wouldn't execute right now (server flags + account setup). */
export function useAutoReadiness(signedIn: boolean) {
  return useQuery({
    queryKey: ["strategies", "auto-readiness"],
    queryFn: () => api.get<AutoReadiness>("/api/strategies/auto-readiness"),
    enabled: signedIn,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useStrategyEvaluation(id: string | null) {
  return useQuery({
    queryKey: ["strategies", id, "eval"],
    queryFn: () => api.get<StrategyEvaluation>(`/api/strategies/${id}/evaluate-now`),
    enabled: Boolean(id),
    refetchInterval: POLL.ruleEval,
  });
}

/** Activity feed: engine state churn + triggers + linked orders with fills. */
export function useStrategyTimeline(id: string | null) {
  return useQuery({
    queryKey: ["strategies", id, "timeline"],
    queryFn: () => api.get<StrategyTimeline>(`/api/strategies/${id}/timeline`),
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
      api.post<{ ok: boolean; autoDisabled: boolean }>(`/api/strategies/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });
}

export function useCreateStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (def: StrategyDefinition & { expiresAt?: string | null; supersedes?: string }) => {
      const { expiresAtMs, version, ...rest } = def;
      void version;
      return api.post<StrategyRow>("/api/strategies", {
        ...rest,
        expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
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
    }) => api.post<StrategyRow>(`/api/strategies/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });
}

/** Replace a strategy's freeform tags (≤10, 1–24 chars — validated server-side). */
export function useSetStrategyTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      api.patch<StrategyRow>(`/api/strategies/${id}/tags`, { tags }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
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
      api.post<DraftEvaluation>("/api/strategies/evaluate-draft", {
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

// ── Instant markets (curated recurring series: BTC 5m up/down et al) ─────────

export interface InstantWindow {
  eventId: string;
  slug: string;
  title: string;
  /** Window OPEN time (derived server-side; Gamma's startDate is creation time). */
  startDate: string;
  endDate: string;
  status: "live" | "upcoming";
  market: MarketSearchResult;
}

export interface InstantSeries {
  seriesSlug: string;
  title: string;
  asset: "BTC" | "ETH" | "SOL" | "XRP" | "DOGE";
  cadence: "5m" | "15m" | "1h";
  recurrence: string;
  windows: InstantWindow[];
}

export interface InstantMarketsResponse {
  generatedAt: string;
  degraded: string[];
  series: InstantSeries[];
}

/**
 * Live + next windows of the curated crypto series. 15s refetch tracks the
 * server cache TTL; countdowns tick client-side off each window's endDate.
 */
export function useInstantMarkets(enabled: boolean) {
  return useQuery({
    queryKey: ["instant-markets"],
    queryFn: () => api.get<InstantMarketsResponse>("/api/markets/instant"),
    enabled,
    staleTime: 10_000,
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
}
