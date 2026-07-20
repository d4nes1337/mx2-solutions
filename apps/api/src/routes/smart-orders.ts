import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  ConditionalRuleRow,
  DelegationStore,
  MarketSnapshotRow,
  MarketSnapshotStore,
  OrderIntentStore,
  PrivyWalletStore,
  RuleStore,
  RuntimeFlagStore,
  SessionStore,
  TriggerStore,
} from "@mx2/db";
import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import {
  EXPR_LIMITS,
  conditionLeaves,
  dataAgeMs,
  evaluateExpression,
  hashDefinition,
  normalizeDefinition,
  recentDrift,
  referencedTokenIds,
  strategyProximity,
  typicalMovement,
  validateStrategyDefinition,
  type BookLevel,
  type ExprNode,
  type MarketDataView,
  type PriceSample,
  type RuleDefinition,
  type StrategyDefinition,
  type StrategyProximity,
  type TriggerEvidenceV2,
  type ViewsByToken,
  type WatermarksByNode,
} from "@mx2/rules";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeRateLimit } from "../middleware/rate-limit.js";
import { smartSearchEventHits, smartSearchMarketHits } from "../lib/market-search.js";

export interface SmartOrdersRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  orderIntents: OrderIntentStore;
  runtimeFlags: RuntimeFlagStore;
  marketSnapshots: MarketSnapshotStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  /** Per-user auto-readiness probes (absent → server-level blockers only). */
  privyWallets?: PrivyWalletStore;
  delegations?: DelegationStore;
}

// ── Request validation (Smart Order DSL v2, ADR-0010) ───────────────────────

const MarketRefSchema = z.object({
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  outcome: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
});

const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price"),
    market: MarketRefSchema,
    source: z.enum(["ask", "bid"]),
    comparator: z.enum(["lte", "gte"]),
    threshold: z.number().gt(0).lt(1),
  }),
  z.object({
    kind: z.literal("spread"),
    market: MarketRefSchema,
    comparator: z.enum(["lte", "gte"]),
    threshold: z.number().gt(0).lt(1),
  }),
  z.object({
    kind: z.literal("cumulative_notional"),
    market: MarketRefSchema,
    source: z.enum(["ask", "bid"]),
    priceBound: z.number().gt(0).lt(1),
    minNotional: z.number().positive(),
  }),
  z.object({
    kind: z.literal("visible_levels"),
    market: MarketRefSchema,
    source: z.enum(["ask", "bid"]),
    priceBound: z.number().gt(0).lt(1),
    minLevels: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("time_window"),
    startMs: z.number().int().nullable(),
    endMs: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("price_move"),
    market: MarketRefSchema,
    direction: z.enum(["drop", "rise", "either"]),
    deltaThreshold: z.number().gt(0).lt(1),
    windowMs: z.number().int().min(60_000).max(3_600_000),
  }),
  z.object({
    kind: z.literal("trailing"),
    market: MarketRefSchema,
    mode: z.enum(["stop", "entry"]),
    source: z.enum(["ask", "bid"]),
    offset: z.number().min(0.01).max(0.5),
  }),
]);

const ExprNodeSchema: z.ZodType<ExprNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("condition"),
      id: z.string().min(1).max(64),
      condition: ConditionSchema,
    }),
    z.object({
      type: z.literal("group"),
      id: z.string().min(1).max(64),
      op: z.enum(["and", "or", "not"]),
      children: z.array(ExprNodeSchema).min(1).max(EXPR_LIMITS.maxConditions),
    }),
  ]),
);

const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("alert") }),
  z.object({
    kind: z.literal("order"),
    market: MarketRefSchema,
    side: z.enum(["BUY", "SELL"]),
    price: z.number().gt(0).lt(1),
    size: z.number().positive(),
    orderType: z.enum(["GTC", "GTD", "FOK", "FAK"]),
    postOnly: z.boolean().optional(),
    expiresAfterMs: z.number().int().min(180_000).max(86_400_000).optional(),
    execution: z.enum(["prepare", "auto"]),
    negRisk: z.boolean().optional(),
    tickSize: z.enum(["0.1", "0.01", "0.001", "0.0001"]).optional(),
  }),
  z.object({ kind: z.literal("stop_strategy"), targetStrategyId: z.string().uuid() }),
  z.object({
    kind: z.literal("quote_loop"),
    market: z.object({
      conditionId: z.string().min(1),
      yesTokenId: z.string().min(1),
      noTokenId: z.string().min(1),
      title: z.string().max(200).optional(),
      negRisk: z.boolean().optional(),
      tickSize: z.enum(["0.1", "0.01", "0.001", "0.0001"]).optional(),
    }),
    sizeShares: z.number().positive(),
    targetSpreadCents: z.number().gt(0).max(10),
    requoteToleranceCents: z.number().gt(0).max(10),
    maxInventoryShares: z.number().positive(),
    maxCapitalUsd: z.number().positive(),
    maxDailyLossUsd: z.number().positive(),
  }),
]);

const RecurrenceSchema = z.union([
  z.object({ kind: z.literal("once") }),
  z.object({
    kind: z.literal("repeat"),
    maxRepeats: z.number().int().min(2).max(100),
    cooldownMs: z.number().int().min(0).max(86_400_000),
  }),
]);

const LimitsSchema = z.object({
  maxNotionalPerOrder: z.number().positive(),
  maxTotalNotional: z.number().positive(),
  maxDailyNotional: z.number().positive(),
});

/**
 * A full (already-compiled) definition as sent back by clients — e.g. the AI
 * route's `currentDefinition`. `version` is optional because compileDoc's
 * output omits it; consumers re-stamp version: 2.
 */
export const StrategyDefinitionSchema = z.object({
  version: z.literal(2).optional(),
  name: z.string().max(200),
  templateId: z.string().max(64).nullable(),
  expr: ExprNodeSchema,
  holdsForMs: z.number().int().min(0).max(86_400_000),
  maxDataAgeMs: z.number().int().positive().max(60_000),
  action: ActionSchema,
  recurrence: RecurrenceSchema,
  limits: LimitsSchema.nullable(),
  expiresAtMs: z.number().int().nullable(),
});

/** PATCH /:id/tags body — ≤10 freeform labels, 1–24 chars each. */
const TagsSchema = z.object({ tags: z.array(z.string().min(1).max(24)).max(10) }).strict();

const CreateSmartOrderSchema = z.object({
  name: z.string().min(1).max(120),
  templateId: z.string().max(64).nullish(),
  expr: ExprNodeSchema,
  // Instant by default (owner decision, 2026-07-19) — hold windows are opt-in.
  holdsForMs: z.number().int().min(0).max(86_400_000).default(0),
  maxDataAgeMs: z.number().int().positive().max(60_000).default(30_000),
  action: ActionSchema,
  recurrence: RecurrenceSchema.default({ kind: "once" }),
  limits: LimitsSchema.nullish(),
  expiresAt: z.string().datetime().nullish(),
  /**
   * Versioned edit: atomically create this strategy AND cancel/link the one it
   * replaces (spend caps carry over). Fixes the old client-side create-then-
   * cancel race where a crash left both strategies armed.
   */
  supersedes: z.string().uuid().nullish(),
});

const EvaluateDraftSchema = z.object({
  /** null = freshness-only probe (no conditions bound yet). */
  expr: ExprNodeSchema.nullable(),
  maxDataAgeMs: z.number().int().positive().max(60_000).default(30_000),
  /**
   * Tokens the canvas shows but the expression doesn't reference (order-action
   * market, watched markets) — included in the freshness/market payload so
   * they don't sit on "waiting for data…" forever.
   */
  extraTokenIds: z.array(z.string().min(1).max(100)).max(8).default([]),
});

// ── Snapshot / REST → normalized views ──────────────────────────────────────

const toLevels = (raw: unknown, side: "ask" | "bid"): BookLevel[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const o = l as { price?: unknown; size?: unknown };
      return { price: Number(o.price), size: Number(o.size) };
    })
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
};

const snapshotToView = (row: MarketSnapshotRow): MarketDataView => {
  const t = new Date(row.receivedAt).getTime();
  return {
    tokenId: row.tokenId,
    conditionId: row.conditionId,
    bids: toLevels(row.bids, "bid"),
    asks: toLevels(row.asks, "ask"),
    marketStatus: row.isStale ? "unknown" : "open",
    sourceTimeMs: t,
    receivedAtMs: t,
  };
};

/** Tokens read by price_move leaves — they need priceHistory attached. */
const priceMoveTokens = (def: StrategyDefinition): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const { condition } of conditionLeaves(def.expr)) {
    if (condition.kind === "price_move" && condition.market.tokenId !== "") {
      tokens.add(condition.market.tokenId);
    }
  }
  return tokens;
};

/**
 * Load a view per token: worker snapshot first, live CLOB REST as fallback
 * (mirrors /api/markets/:id/orderbook). Tokens that fail both stay absent —
 * the evaluator treats them as stale (fail-closed). Tokens in `historyTokens`
 * additionally get a 1-min-fidelity trailing price series attached so
 * price_move drafts evaluate honestly (coarser than the worker's live window;
 * disclosed in the builder copy).
 */
const loadViews = async (
  deps: SmartOrdersRoutesDeps,
  tokenIds: readonly string[],
  nowMs: number,
  historyTokens?: ReadonlySet<string>,
): Promise<ViewsByToken> => {
  const views: Record<string, MarketDataView> = {};
  await Promise.all(
    tokenIds.map(async (tokenId) => {
      const [snapshot, history] = await Promise.all([
        deps.marketSnapshots.findByTokenId(tokenId),
        historyTokens?.has(tokenId)
          ? deps.clobClient.getPricesHistory({ tokenId, interval: "1d", fidelity: 1 })
          : Promise.resolve(null),
      ]);
      const priceHistory =
        history !== null && history.ok
          ? history.value
              .map((s) => ({ t: s.t < 1e12 ? s.t * 1000 : s.t, p: s.p }))
              .sort((a, b) => a.t - b.t)
          : undefined;
      const withHistory = (v: MarketDataView): MarketDataView =>
        priceHistory && priceHistory.length > 0 ? { ...v, priceHistory } : v;

      const snapshotView = snapshot !== null ? withHistory(snapshotToView(snapshot)) : null;
      if (snapshot !== null && !snapshot.isStale) {
        views[tokenId] = snapshotView!;
        return;
      }
      const ob = await deps.clobClient.getOrderbook(tokenId);
      if (ob.ok) {
        views[tokenId] = withHistory({
          tokenId,
          conditionId: "",
          bids: toLevels(ob.value.bids, "bid"),
          asks: toLevels(ob.value.asks, "ask"),
          marketStatus: "open",
          sourceTimeMs: nowMs,
          receivedAtMs: nowMs,
        });
      } else if (snapshotView !== null) {
        views[tokenId] = snapshotView; // stale — evaluator flags it
      }
    }),
  );
  return views;
};

const marketFreshness = (views: ViewsByToken, tokenIds: readonly string[], nowMs: number) =>
  tokenIds.map((tokenId) => {
    const v = views[tokenId];
    return {
      tokenId,
      hasData: v !== undefined,
      dataAgeMs: v ? dataAgeMs(v, nowMs) : null,
      bestBid: v?.bids[0]?.price ?? null,
      bestAsk: v?.asks[0]?.price ?? null,
    };
  });

/**
 * Serialized strategy row: raw row + the definition normalized to v2, plus the
 * server-level auto-degradation marker. `autoDegraded` is true when the rule
 * asks for unattended execution but the server cannot deliver it — the exact
 * silent failure that stranded the owner's triggers at "awaiting confirmation".
 * Per-user blockers (wallet/allowances/delegation) come from /auto-readiness.
 */
const serializeStrategy = (row: ConditionalRuleRow, liveExecutionEnabled: boolean) => {
  const definitionV2 = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
  const wantsAuto =
    definitionV2.action.kind === "order" && definitionV2.action.execution === "auto";
  return {
    ...row,
    definitionV2,
    autoDegraded: wantsAuto && !liveExecutionEnabled,
    degradedReason: wantsAuto && !liveExecutionEnabled ? "live_execution_disabled" : null,
  };
};

// ── Dashboard overview (batch proximity + actionability + sparklines) ────────

/** Wire sparkline point: unix SECONDS + 3dp price (payload every 5s poll). */
interface SparkPoint {
  t: number;
  p: number;
}

interface SparkCacheEntry {
  at: number;
  series: SparkPoint[];
  /** Fine ms-series attached to views for price_move evaluation only. */
  fine?: PriceSample[];
}

export interface StrategyOverviewItem {
  id: string;
  /** strategyProximity().rank; meaningful only when proximity is non-null. */
  rank: number;
  proximity: {
    bindingDistance: number | null;
    bindingTokenId: string | null;
    drift: StrategyProximity["drift"];
    dwellFraction: number | null;
    blockedBy: string[];
    leaves: StrategyProximity["leaves"];
  } | null;
  /** Only for TRIGGERED_AWAITING_USER order strategies with a pending signature. */
  actionability: {
    kind: "ready" | "missed";
    stillHolds: boolean;
    triggerId: string | null;
    triggeredAt: string | null;
    priceAtTrigger: number | null;
    priceNow: number | null;
    /** Prob units; > 0 = current price beats the asked threshold. */
    edge: number | null;
    edgeUsd: number | null;
  } | null;
}

export interface OverviewResponse {
  generatedAt: string;
  strategies: StrategyOverviewItem[];
  sparklines: Record<string, SparkPoint[]>;
  books: Record<string, { bestBid: number | null; bestAsk: number | null; stale: boolean }>;
}

const SPARKLINE_TTL_MS = 60_000;
const SPARKLINE_MAX_POINTS = 60;
/** Max tokens whose expired cache entries refill per request (soft TTL). */
const SPARKLINE_REFILL_BUDGET = 8;
/** Max distinct tokens the overview serves (triggered rows claim slots first). */
const OVERVIEW_TOKEN_CAP = 40;
/** Drift lookback for the approaching/retreating arrow. */
const DRIFT_LOOKBACK_MS = 30 * 60_000;
/** A book older than this reads as stale regardless of the stored flag. */
const BOOK_FRESH_MS = 60_000;
/**
 * Ranking freshness, deliberately looser than execution freshness: the worker
 * skips rewriting an unchanged book, so a quiet market's snapshot can sit for
 * minutes while its data is genuinely current. "How far is the trigger?" stays
 * answerable from such a book; money claims (edge) keep BOOK_FRESH_MS and
 * execution keeps the strategy's own maxDataAgeMs + TriggerConfirm's live
 * fetch. Books older than this rank as stale (fail-closed tail).
 */
const RANKING_FRESH_MS = 5 * 60_000;

const sparklineCache = new Map<string, SparkCacheEntry>();
/** Test hook — module-level cache would otherwise leak between route tests. */
export const clearOverviewCacheForTests = (): void => sparklineCache.clear();

const toSparkSeconds = (t: number): number => (t < 1e12 ? Math.round(t) : Math.round(t / 1000));
const toMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

/**
 * Refill expired sparkline entries within the per-request budget; entries past
 * TTL but over budget serve stale (better a 2-min-old sparkline than an
 * upstream stampede). A failed fetch caches an empty series for one TTL so a
 * dead token cannot retry-storm. `fineTokens` additionally get a 1-min series
 * for price_move evaluation.
 */
const ensureSparklines = async (
  deps: SmartOrdersRoutesDeps,
  tokenIds: readonly string[],
  fineTokens: ReadonlySet<string>,
  nowMs: number,
): Promise<void> => {
  const expired = tokenIds.filter((tokenId) => {
    const entry = sparklineCache.get(tokenId);
    if (!entry || nowMs - entry.at > SPARKLINE_TTL_MS) return true;
    // A token newly referenced by price_move needs its fine series backfilled.
    return fineTokens.has(tokenId) && entry.fine === undefined;
  });
  await Promise.all(
    expired.slice(0, SPARKLINE_REFILL_BUDGET).map(async (tokenId) => {
      const [spark, fine] = await Promise.all([
        deps.clobClient.getPricesHistory({ tokenId, interval: "1d", fidelity: 15 }),
        fineTokens.has(tokenId)
          ? deps.clobClient.getPricesHistory({ tokenId, interval: "6h", fidelity: 1 })
          : Promise.resolve(null),
      ]);
      const series = spark.ok
        ? spark.value
            .map((s) => ({ t: toSparkSeconds(s.t), p: Math.round(s.p * 1000) / 1000 }))
            .sort((a, b) => a.t - b.t)
            .slice(-SPARKLINE_MAX_POINTS)
        : [];
      const entry: SparkCacheEntry = { at: nowMs, series };
      if (fine !== null && fine.ok) {
        entry.fine = fine.value.map((s) => ({ t: toMs(s.t), p: s.p })).sort((a, b) => a.t - b.t);
      }
      sparklineCache.set(tokenId, entry);
    }),
  );
};

/**
 * The price leaf that expresses the order's entry condition (BUY: ask ≤ X,
 * SELL: bid ≥ X) on the action's token — the threshold behind "better/worse
 * than you asked". Null for strategies without such a leaf (edge is then
 * unknowable and actionability falls back to stillHolds alone).
 */
const actionPriceLeaf = (def: StrategyDefinition): { threshold: number } | null => {
  if (def.action.kind !== "order") return null;
  const action = def.action;
  for (const { condition } of conditionLeaves(def.expr)) {
    if (
      condition.kind === "price" &&
      condition.market.tokenId === action.market.tokenId &&
      (action.side === "BUY"
        ? condition.source === "ask" && condition.comparator === "lte"
        : condition.source === "bid" && condition.comparator === "gte")
    ) {
      return { threshold: condition.threshold };
    }
  }
  return null;
};

export const registerSmartOrdersRoutes = (
  app: FastifyInstance,
  deps: SmartOrdersRoutesDeps,
): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.conditionalRules || !deps.config.features.smartOrdersV2) {
      await reply.code(503).send({
        error: "SMART_ORDERS_DISABLED",
        message: "Smart Orders are disabled on this server.",
      });
    }
  };

  const guard = { preHandler: [requireAuth, requireEnabled] };
  const publicGuard = (scope: string, limit: number) => ({
    preHandler: [requireEnabled, makeRateLimit({ scope, limit, windowMs: 60_000 })],
  });

  // ── GET /api/smart-orders/auto-readiness — why auto wouldn't execute ──────
  // Surfaces every blocker between an armed auto strategy and an unattended
  // order, so "AUTO" can never silently mean "waiting for you to click".
  app.get("/api/smart-orders/auto-readiness", guard, async (req) => {
    const user = req.user!;
    const blockers: { code: string; detail: string }[] = [];
    const f = deps.config.features;
    if (!f.conditionalLiveExecution) {
      blockers.push({
        code: "live_execution_disabled",
        detail:
          "Unattended execution is disabled on this server — triggers wait for your confirmation.",
      });
    }
    if (!f.liveTrading) {
      blockers.push({
        code: "live_trading_disabled",
        detail: "Live trading is disabled on this server.",
      });
    }
    if (!f.privySigning) {
      blockers.push({
        code: "privy_signing_disabled",
        detail: "Server-side signing is disabled — orders need your wallet signature.",
      });
    }
    if (deps.privyWallets) {
      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        blockers.push({
          code: "wallet_not_provisioned",
          detail: "No trading wallet yet — activate one in Wallet.",
        });
      } else if (!wallet.allowancesBootstrappedAt) {
        blockers.push({
          code: "allowances_missing",
          detail: "Trading not authorized yet — press “Authorize trading” in Wallet.",
        });
      }
    }
    if (deps.delegations) {
      const delegation = await deps.delegations.findActive(user.walletAddress);
      if (!delegation) {
        blockers.push({
          code: "delegation_missing",
          detail: "No active trading session — re-delegate in Wallet.",
        });
      }
    }
    const killSwitch = await deps.runtimeFlags.get("trading_paused");
    if (killSwitch?.value === "true") {
      blockers.push({ code: "kill_switch", detail: "Trading is globally paused." });
    }
    return { autoExecutionEnabled: f.conditionalLiveExecution, blockers };
  });

  // ── GET /api/smart-orders/overview — batch dashboard state ────────────────
  // One call per poll for the whole Smart Orders page: proximity ranking for
  // waiting strategies, ready/missed classification for triggered ones, and a
  // shared per-token sparkline + book map. Reads worker snapshots + a 60s-TTL
  // history cache only — never fans out to upstream per strategy (fail-closed:
  // a token without a fresh snapshot ranks/classifies as stale).
  app.get("/api/smart-orders/overview", guard, async (req) => {
    const user = req.user!;
    const nowMs = Date.now();
    const rows = await deps.ruleStore.listByWallet(user.walletAddress, 100);

    const defs = new Map<string, StrategyDefinition>();
    for (const row of rows) {
      defs.set(row.id, normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition));
    }

    // Token slots: triggered rows first (their cards carry the money actions).
    const ordered: string[] = [];
    const seen = new Set<string>();
    const claim = (row: ConditionalRuleRow): void => {
      for (const tokenId of referencedTokenIds(defs.get(row.id)!)) {
        if (tokenId !== "" && !seen.has(tokenId)) {
          seen.add(tokenId);
          ordered.push(tokenId);
        }
      }
    };
    for (const row of rows) if (row.status === "TRIGGERED_AWAITING_USER") claim(row);
    for (const row of rows) claim(row);
    const tokens = ordered.slice(0, OVERVIEW_TOKEN_CAP);
    const tokenSet = new Set(tokens);

    const fineTokens = new Set<string>();
    for (const row of rows) {
      for (const t of priceMoveTokens(defs.get(row.id)!)) {
        if (tokenSet.has(t)) fineTokens.add(t);
      }
    }
    await ensureSparklines(deps, tokens, fineTokens, nowMs);

    // Snapshot-only views (no CLOB fallback) + history-derived rank inputs.
    const views: Record<string, MarketDataView> = {};
    const books: OverviewResponse["books"] = {};
    const sparklines: OverviewResponse["sparklines"] = {};
    const typicalMoveByToken: Record<string, number> = {};
    const driftByToken: Record<string, number> = {};
    await Promise.all(
      tokens.map(async (tokenId) => {
        const snapshot = await deps.marketSnapshots.findByTokenId(tokenId);
        if (snapshot !== null) {
          const view = snapshotToView(snapshot);
          const fine = sparklineCache.get(tokenId)?.fine;
          views[tokenId] =
            fine !== undefined && fine.length > 0 ? { ...view, priceHistory: fine } : view;
          books[tokenId] = {
            bestBid: view.bids[0]?.price ?? null,
            bestAsk: view.asks[0]?.price ?? null,
            // The stored flag only moves while the worker runs — age-bound it
            // so a snapshot from before a downtime can't pose as live.
            stale: snapshot.isStale || nowMs - view.receivedAtMs > BOOK_FRESH_MS,
          };
        } else {
          books[tokenId] = { bestBid: null, bestAsk: null, stale: true };
        }
        const series = sparklineCache.get(tokenId)?.series ?? [];
        sparklines[tokenId] = series;
        const msSeries = series.map((s) => ({ t: s.t * 1000, p: s.p }));
        const typical = typicalMovement(msSeries);
        if (typical !== null) typicalMoveByToken[tokenId] = typical;
        const drift = recentDrift(msSeries, DRIFT_LOOKBACK_MS);
        if (drift !== null) driftByToken[tokenId] = drift;
      }),
    );

    const awaiting = await deps.triggerStore.listAwaiting(user.walletAddress);
    const awaitingByRule = new Map(awaiting.map((t) => [t.ruleId, t]));

    const strategies: StrategyOverviewItem[] = rows.map((row) => {
      const def = defs.get(row.id)!;
      const item: StrategyOverviewItem = {
        id: row.id,
        rank: 0,
        proximity: null,
        actionability: null,
      };

      if (row.status === "ACTIVE_WAITING" || row.status === "ACTIVE_ACCUMULATING") {
        const rankingDef =
          def.maxDataAgeMs >= RANKING_FRESH_MS ? def : { ...def, maxDataAgeMs: RANKING_FRESH_MS };
        const p = strategyProximity(rankingDef, views, nowMs, {
          watermarks: (row.runtimeWatermarks ?? {}) as WatermarksByNode,
          trueSinceMs:
            row.status === "ACTIVE_ACCUMULATING" && row.trueSince !== null
              ? new Date(row.trueSince).getTime()
              : null,
          typicalMoveByToken,
          driftByToken,
        });
        item.rank = p.rank;
        item.proximity = {
          bindingDistance: p.bindingDistance,
          bindingTokenId: p.bindingTokenId,
          drift: p.drift,
          dwellFraction: p.dwellFraction,
          blockedBy: [...p.blockedBy],
          leaves: p.leaves,
        };
      }

      if (row.status === "TRIGGERED_AWAITING_USER" && def.action.kind === "order") {
        const action = def.action;
        const trigger = awaitingByRule.get(row.id) ?? null;
        const evidence = (trigger?.evidence ?? null) as TriggerEvidenceV2 | null;
        const stillHolds = evaluateExpression(
          def,
          views,
          nowMs,
          (row.runtimeWatermarks ?? {}) as WatermarksByNode,
        ).satisfied;
        const book = books[action.market.tokenId];
        // A stale book must never back a confident edge or "missed" claim —
        // without fresh data the honest state is "awaiting your signature"
        // (the TriggerConfirm preview refetches live before any money moves).
        const fresh = book !== undefined && !book.stale;
        const priceNow = fresh
          ? ((action.side === "BUY" ? book.bestAsk : book.bestBid) ?? null)
          : null;
        const leaf = actionPriceLeaf(def);
        const edge =
          leaf !== null && priceNow !== null
            ? action.side === "BUY"
              ? leaf.threshold - priceNow
              : priceNow - leaf.threshold
            : null;
        item.actionability = {
          kind: !fresh || stillHolds || (edge !== null && edge >= -1e-9) ? "ready" : "missed",
          stillHolds,
          triggerId: trigger?.id ?? null,
          triggeredAt: trigger !== null ? trigger.triggeredAt.toISOString() : null,
          priceAtTrigger:
            evidence !== null
              ? action.side === "BUY"
                ? evidence.bestAsk
                : evidence.bestBid
              : null,
          priceNow,
          edge,
          edgeUsd: edge !== null ? Math.round(edge * action.size * 100) / 100 : null,
        };
      }

      return item;
    });

    const response: OverviewResponse = {
      generatedAt: new Date(nowMs).toISOString(),
      strategies,
      sparklines,
      books,
    };
    return response;
  });

  // ── POST /api/smart-orders — create + arm ─────────────────────────────────
  app.post("/api/smart-orders", guard, async (req, reply) => {
    const user = req.user!;
    const parsed = CreateSmartOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const b = parsed.data;
    const expiresAtMs = b.expiresAt ? new Date(b.expiresAt).getTime() : null;
    // Maker loops are separately feature-gated (RFC-0003) on top of the
    // smart-orders flags this route already requires.
    if (b.action.kind === "quote_loop" && !deps.config.features.makerLoop) {
      reply.code(503);
      return {
        error: "MAKER_LOOP_DISABLED",
        message: "Maker loops are not enabled on this server.",
      };
    }
    // Rebuild the action without explicit-undefined optionals (exactOptionalPropertyTypes).
    const action =
      b.action.kind === "order"
        ? {
            kind: "order" as const,
            market: b.action.market,
            side: b.action.side,
            price: b.action.price,
            size: b.action.size,
            orderType: b.action.orderType,
            execution: b.action.execution,
            ...(b.action.postOnly !== undefined ? { postOnly: b.action.postOnly } : {}),
            ...(b.action.expiresAfterMs !== undefined
              ? { expiresAfterMs: b.action.expiresAfterMs }
              : {}),
            ...(b.action.negRisk !== undefined ? { negRisk: b.action.negRisk } : {}),
            ...(b.action.tickSize !== undefined ? { tickSize: b.action.tickSize } : {}),
          }
        : b.action.kind === "quote_loop"
          ? {
              kind: "quote_loop" as const,
              market: {
                conditionId: b.action.market.conditionId,
                yesTokenId: b.action.market.yesTokenId,
                noTokenId: b.action.market.noTokenId,
                ...(b.action.market.title !== undefined ? { title: b.action.market.title } : {}),
                ...(b.action.market.negRisk !== undefined
                  ? { negRisk: b.action.market.negRisk }
                  : {}),
                ...(b.action.market.tickSize !== undefined
                  ? { tickSize: b.action.market.tickSize }
                  : {}),
              },
              sizeShares: b.action.sizeShares,
              targetSpreadCents: b.action.targetSpreadCents,
              requoteToleranceCents: b.action.requoteToleranceCents,
              maxInventoryShares: b.action.maxInventoryShares,
              maxCapitalUsd: b.action.maxCapitalUsd,
              maxDailyLossUsd: b.action.maxDailyLossUsd,
            }
          : b.action;
    const definition: StrategyDefinition = {
      version: 2,
      name: b.name,
      templateId: b.templateId ?? null,
      expr: b.expr,
      holdsForMs: b.holdsForMs,
      maxDataAgeMs: b.maxDataAgeMs,
      action,
      recurrence: b.recurrence,
      limits: b.limits ?? null,
      expiresAtMs,
    };

    // Arm-time validation: structural caps, limits sanity, repeat rules.
    const issues = validateStrategyDefinition(definition, Date.now());
    if (issues.length > 0) {
      reply.code(400);
      return { error: "INVALID_STRATEGY", issues };
    }

    // Verify every referenced market really exists and the tokenId belongs to
    // the claimed conditionId (fail-closed on Gamma errors).
    const refs = new Map<string, string>();
    for (const { condition } of conditionLeaves(definition.expr)) {
      if (condition.kind !== "time_window")
        refs.set(condition.market.tokenId, condition.market.conditionId);
    }
    if (definition.action.kind === "order")
      refs.set(definition.action.market.tokenId, definition.action.market.conditionId);
    if (definition.action.kind === "quote_loop") {
      refs.set(definition.action.market.yesTokenId, definition.action.market.conditionId);
      refs.set(definition.action.market.noTokenId, definition.action.market.conditionId);
    }
    for (const [tokenId, conditionId] of refs) {
      const found = await deps.gammaClient.findMarket({ tokenId });
      if (!found.ok) {
        reply.code(502);
        return { error: "MARKET_LOOKUP_FAILED", message: found.error.message };
      }
      if (!found.value || found.value.conditionId !== conditionId) {
        reply.code(400);
        return {
          error: "MARKET_MISMATCH",
          message: `Token ${tokenId.slice(0, 10)}… does not belong to the referenced market.`,
        };
      }
    }

    // Primary market fills the legacy NOT NULL columns (indexing + v1 tooling).
    const primary =
      definition.action.kind === "order"
        ? definition.action.market
        : definition.action.kind === "quote_loop"
          ? {
              conditionId: definition.action.market.conditionId,
              tokenId: definition.action.market.yesTokenId,
            }
          : (
              conditionLeaves(definition.expr)
                .map((l) => l.condition)
                .find((c) => c.kind !== "time_window") as
                | { market?: { conditionId: string; tokenId: string } }
                | undefined
            )?.market;
    if (!primary) {
      reply.code(400);
      return { error: "INVALID_STRATEGY", message: "Strategy must reference at least one market." };
    }

    const definitionHash = hashDefinition(definition);
    const createOpts = {
      walletAddress: user.walletAddress,
      conditionId: primary.conditionId,
      tokenId: primary.tokenId,
      side: definition.action.kind === "order" ? definition.action.side : ("BUY" as const),
      definition,
      definitionHash,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs),
      version: 2,
      name: b.name,
      templateId: b.templateId ?? null,
      tokenIds: referencedTokenIds(definition),
    };

    let rule;
    if (b.supersedes) {
      // Versioned edit (D-020): one transaction creates the replacement,
      // cancels the old rule, links both directions, and carries lifetime
      // spend accounting forward — editing can never reset caps.
      const result = await deps.ruleStore.createSuperseding(createOpts, b.supersedes);
      if (!result) {
        reply.code(409);
        return {
          error: "SUPERSEDE_CONFLICT",
          message:
            "The strategy you're editing is no longer active (it may have triggered, been cancelled, or already been replaced). Review it and create a new strategy instead.",
        };
      }
      rule = result.created;
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${result.retired.id}`,
        metadata: {
          from: result.retired.status,
          to: "CANCELLED",
          reason: "SUPERSEDED",
          supersededBy: rule.id,
        },
      });
    } else {
      rule = await deps.ruleStore.create(createOpts);
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.created",
      subject: `rule:${rule.id}`,
      metadata: {
        version: 2,
        definitionHash,
        templateId: b.templateId ?? null,
        actionKind: definition.action.kind,
        execution: definition.action.kind === "order" ? definition.action.execution : null,
        conditionCount: conditionLeaves(definition.expr).length,
        marketCount: referencedTokenIds(definition).length,
        recurrence: definition.recurrence.kind,
        holdsForMs: definition.holdsForMs,
        ...(b.supersedes ? { supersedes: b.supersedes } : {}),
      },
    });
    reply.code(201);
    return serializeStrategy(rule, deps.config.features.conditionalLiveExecution);
  });

  // ── GET /api/smart-orders — every strategy incl. v1 rules (normalized) ─────
  // Archived rows are hidden unless ?includeArchived=1 (reversible soft-hide).
  app.get("/api/smart-orders", guard, async (req) => {
    const user = req.user!;
    const includeArchived = (req.query as Record<string, string>)["includeArchived"] === "1";
    const rows = await deps.ruleStore.listByWallet(user.walletAddress, 100, { includeArchived });
    return {
      strategies: rows.map((r) =>
        serializeStrategy(r, deps.config.features.conditionalLiveExecution),
      ),
    };
  });

  app.get("/api/smart-orders/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const row = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }
    // Per-strategy auto kill state (W8) so the detail page can show/toggle it.
    const disarmFlag = await deps.runtimeFlags.get(`rule_auto_disabled:${id}`);
    return {
      ...serializeStrategy(row, deps.config.features.conditionalLiveExecution),
      autoDisabled: disarmFlag?.value === "true",
    };
  });

  // ── Controls ────────────────────────────────────────────────────────────────
  const control = (
    action: "pause" | "resume" | "cancel",
    fn: (id: string, wallet: string) => Promise<ConditionalRuleRow | null>,
  ) =>
    app.post(`/api/smart-orders/:id/${action}`, guard, async (req, reply) => {
      const user = req.user!;
      const { id } = req.params as { id: string };
      const row = await fn(id, user.walletAddress);
      if (!row) {
        reply.code(409);
        return {
          error: "INVALID_STATE",
          message: `This Smart Order cannot be ${action}d in its current state.`,
        };
      }
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${id}`,
        metadata: { control: action },
      });
      return serializeStrategy(row, deps.config.features.conditionalLiveExecution);
    });

  control("pause", (id, w) => deps.ruleStore.pause(id, w));
  control("resume", (id, w) => deps.ruleStore.resume(id, w));
  control("cancel", (id, w) => deps.ruleStore.cancel(id, w));

  // ── Organization: tags + reversible archive ────────────────────────────────
  app.patch("/api/smart-orders/:id/tags", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const parsed = TagsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    // Normalize: lowercase, trim, dedupe — the shared vocabulary with drafts.
    const tags = [...new Set(parsed.data.tags.map((t) => t.trim().toLowerCase()))].filter(
      (t) => t.length > 0,
    );
    const row = await deps.ruleStore.setTags(id, user.walletAddress, tags);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.state_changed",
      subject: `rule:${id}`,
      metadata: { control: "tags", tags },
    });
    return serializeStrategy(row, deps.config.features.conditionalLiveExecution);
  });

  // Starred strategies float to the top of their dashboard section.
  app.patch("/api/smart-orders/:id/star", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const parsed = z.object({ starred: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const row = await deps.ruleStore.setStarred(id, user.walletAddress, parsed.data.starred);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.state_changed",
      subject: `rule:${id}`,
      metadata: { control: "star", starred: parsed.data.starred },
    });
    return serializeStrategy(row, deps.config.features.conditionalLiveExecution);
  });

  const archiveControl = (label: "archive" | "unarchive") =>
    app.post(`/api/smart-orders/:id/${label}`, guard, async (req, reply) => {
      const user = req.user!;
      const { id } = req.params as { id: string };
      const row =
        label === "archive"
          ? await deps.ruleStore.archive(id, user.walletAddress)
          : await deps.ruleStore.unarchive(id, user.walletAddress);
      if (!row) {
        reply.code(409);
        return {
          error: "INVALID_STATE",
          message:
            label === "archive"
              ? "Only ended Smart Orders can be archived."
              : "Smart Order not found.",
        };
      }
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${id}`,
        metadata: { control: label },
      });
      return serializeStrategy(row, deps.config.features.conditionalLiveExecution);
    });

  archiveControl("archive");
  archiveControl("unarchive");

  // ── Disarm / re-arm auto execution (per-strategy kill, W8) ────────────────
  // Flips a runtime flag the auto-executor checks pre-flight. The definition
  // itself stays immutable (evidence hash), and triggers degrade to
  // ask-to-sign while disarmed.
  const setAutoDisabled = (disabled: boolean, label: "disarm" | "rearm") =>
    app.post(`/api/smart-orders/:id/${label}`, guard, async (req, reply) => {
      const user = req.user!;
      const { id } = req.params as { id: string };
      const row = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
      if (!row) {
        reply.code(404);
        return { error: "NOT_FOUND", message: "Smart Order not found" };
      }
      const def = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
      if (!(def.action.kind === "order" && def.action.execution === "auto")) {
        reply.code(409);
        return {
          error: "NOT_AUTO",
          message: "This Smart Order does not use auto execution.",
        };
      }
      await deps.runtimeFlags.set(
        `rule_auto_disabled:${id}`,
        disabled ? "true" : "false",
        user.walletAddress,
      );
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${id}`,
        metadata: { control: label },
      });
      return { ok: true, autoDisabled: disabled };
    });

  setAutoDisabled(true, "disarm");
  setAutoDisabled(false, "rearm");

  // ── GET /api/smart-orders/:id/evaluate-now — live "would trigger?" ────────
  app.get("/api/smart-orders/:id/evaluate-now", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const row = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }
    const def = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
    const tokens = referencedTokenIds(def);
    const nowMs = Date.now();
    const views = await loadViews(deps, tokens, nowMs, priceMoveTokens(def));
    // Armed strategies carry real trailing state — pass it so the monitor
    // shows the actual peak/trough and trigger level, not a fresh "arming".
    // (Read-only here: the worker remains the single writer of watermarks.)
    const evaluation = evaluateExpression(
      def,
      views,
      nowMs,
      (row.runtimeWatermarks as WatermarksByNode | null) ?? {},
    );
    return {
      strategyId: row.id,
      status: row.status,
      satisfied: evaluation.satisfied,
      root: evaluation.root,
      staleTokenIds: evaluation.staleTokenIds,
      holdsForMs: def.holdsForMs,
      maxDataAgeMs: def.maxDataAgeMs,
      trueSince: row.trueSince,
      triggerCount: row.triggerCount,
      cooldownUntil: row.cooldownUntil,
      markets: marketFreshness(views, tokens, nowMs),
    };
  });

  // ── GET /api/smart-orders/:id/timeline — activity feed for one strategy ───
  // What the engine actually did: state churn (window started / stale resets /
  // restarts), triggers, and the orders they produced with live fill state.
  app.get("/api/smart-orders/:id/timeline", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query["limit"] ?? 100) || 100, 1), 200);
    const beforeRaw = query["before"];
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before !== undefined && Number.isNaN(before.getTime())) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "before must be an ISO timestamp" };
    }
    const row = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }

    const [events, triggers] = await Promise.all([
      deps.auditStore.forSubject(`rule:${id}`, limit, before),
      deps.triggerStore.listByRule(id),
    ]);
    const intentIds = triggers.map((t) => t.orderIntentId).filter((v): v is string => v !== null);
    const [linked, byMetadata] = await Promise.all([
      deps.orderIntents.findByIds(intentIds),
      deps.orderIntents.listByRuleMetadata(id),
    ]);
    // findByIds is not wallet-scoped — re-filter so a foreign intent id that
    // slipped into a trigger link can never surface another user's order.
    const orders = [...new Map([...linked, ...byMetadata].map((o) => [o.id, o])).values()]
      .filter((o) => o.walletAddress === user.walletAddress)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      strategyId: row.id,
      status: row.status,
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        action: e.action,
        metadata: e.metadata,
      })),
      triggers: triggers.map((t) => ({
        id: t.id,
        triggeredAt: t.triggeredAt,
        status: t.status,
        reasonCodes: t.reasonCodes,
        orderIntentId: t.orderIntentId,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        createdAt: o.createdAt,
        status: o.status,
        side: o.side,
        price: o.price,
        size: o.size,
        orderType: o.orderType,
        clobOrderId: o.clobOrderId,
        filledSize: o.filledSize,
        avgFillPrice: o.avgFillPrice,
        tokenId: o.tokenId,
        conditionId: o.conditionId,
        errorMessage: o.errorMessage,
      })),
    };
  });

  // ── POST /api/smart-orders/evaluate-draft — PUBLIC (builder playground) ───
  app.post(
    "/api/smart-orders/evaluate-draft",
    publicGuard("draft-eval", 60),
    async (req, reply) => {
      const parsed = EvaluateDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "INVALID_REQUEST",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }
      // Wrap the draft expression in a minimal definition so the shared
      // validator enforces the same structural caps as arm-time. A null expr
      // is a freshness-only probe: the canvas still needs live prices for
      // markets no condition references yet (order-action / watched markets).
      const draftDef: StrategyDefinition | null =
        parsed.data.expr === null
          ? null
          : {
              version: 2,
              name: "draft",
              templateId: null,
              expr: parsed.data.expr,
              holdsForMs: 0,
              maxDataAgeMs: parsed.data.maxDataAgeMs,
              action: { kind: "alert" },
              recurrence: { kind: "once" },
              limits: null,
              expiresAtMs: null,
            };
      if (draftDef !== null) {
        const structural = validateStrategyDefinition(draftDef).filter((i) =>
          i.code.startsWith("EXPR_"),
        );
        if (structural.length > 0) {
          reply.code(400);
          return { error: "INVALID_STRATEGY", issues: structural };
        }
      }

      // Cap the total live-lookup fan-out: this endpoint is public, and each
      // snapshot-miss token costs one upstream CLOB call. 8 total keeps the
      // worst case at the pre-existing ceiling (4 expr markets × book+history).
      const tokens = [
        ...new Set([
          ...(draftDef !== null ? referencedTokenIds(draftDef) : []),
          ...parsed.data.extraTokenIds,
        ]),
      ].slice(0, 8);
      const nowMs = Date.now();
      const views = await loadViews(
        deps,
        tokens,
        nowMs,
        draftDef !== null ? priceMoveTokens(draftDef) : undefined,
      );
      const evaluation = draftDef !== null ? evaluateExpression(draftDef, views, nowMs) : null;
      return {
        satisfied: evaluation?.satisfied ?? false,
        root: evaluation?.root ?? null,
        staleTokenIds: evaluation?.staleTokenIds ?? [],
        markets: marketFreshness(views, tokens, nowMs),
        evaluatedAt: new Date(nowMs).toISOString(),
      };
    },
  );

  // ── GET /api/markets/search — PUBLIC (@market mentions) ───────────────────
  app.get("/api/markets/search", publicGuard("market-search", 120), async (req, reply) => {
    const q = ((req.query as Record<string, string>)["q"] ?? "").trim();
    if (q.length < 2 || q.length > 80) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "q must be 2–80 characters." };
    }
    const result = await smartSearchMarketHits(deps.gammaClient, q, { limit: 15 });
    if (!result.ok) {
      reply.code(502);
      return { error: result.error.code, message: result.error.message };
    }
    return { results: result.value };
  });

  // ── GET /api/markets/search/grouped — PUBLIC (Markets tab + builder) ──────
  // Event-granularity results: each hit keeps ALL its sub-markets (totals,
  // spreads, candidates). Shares the flat search's cache AND its rate-limit
  // scope, so the two endpoints draw from one Gamma budget.
  app.get("/api/markets/search/grouped", publicGuard("market-search", 120), async (req, reply) => {
    const q = ((req.query as Record<string, string>)["q"] ?? "").trim();
    if (q.length < 2 || q.length > 80) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "q must be 2–80 characters." };
    }
    const result = await smartSearchEventHits(deps.gammaClient, q, {
      limit: 10,
      marketsPerEvent: 20,
    });
    if (!result.ok) {
      reply.code(502);
      return { error: result.error.code, message: result.error.message };
    }
    return { results: result.value };
  });
};
