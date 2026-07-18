import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  ConditionalRuleRow,
  MarketSnapshotRow,
  MarketSnapshotStore,
  RuleStore,
  RuntimeFlagStore,
  SessionStore,
} from "@mx2/db";
import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import {
  EXPR_LIMITS,
  conditionLeaves,
  dataAgeMs,
  evaluateExpression,
  hashDefinition,
  normalizeDefinition,
  referencedTokenIds,
  validateStrategyDefinition,
  type BookLevel,
  type ExprNode,
  type MarketDataView,
  type RuleDefinition,
  type StrategyDefinition,
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
  runtimeFlags: RuntimeFlagStore;
  marketSnapshots: MarketSnapshotStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
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
  holdsForMs: z.number().int().min(0).max(86_400_000).default(300_000),
  maxDataAgeMs: z.number().int().positive().max(60_000).default(5_000),
  action: ActionSchema,
  recurrence: RecurrenceSchema.default({ kind: "once" }),
  limits: LimitsSchema.nullish(),
  expiresAt: z.string().datetime().nullish(),
});

const EvaluateDraftSchema = z.object({
  expr: ExprNodeSchema,
  maxDataAgeMs: z.number().int().positive().max(60_000).default(10_000),
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

/** Serialized strategy row: raw row + the definition normalized to v2. */
const serializeStrategy = (row: ConditionalRuleRow) => ({
  ...row,
  definitionV2: normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition),
});

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
    const rule = await deps.ruleStore.create({
      walletAddress: user.walletAddress,
      conditionId: primary.conditionId,
      tokenId: primary.tokenId,
      side: definition.action.kind === "order" ? definition.action.side : "BUY",
      definition,
      definitionHash,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs),
      version: 2,
      name: b.name,
      templateId: b.templateId ?? null,
      tokenIds: referencedTokenIds(definition),
    });
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
      },
    });
    reply.code(201);
    return serializeStrategy(rule);
  });

  // ── GET /api/smart-orders — every strategy incl. v1 rules (normalized) ─────
  // Archived rows are hidden unless ?includeArchived=1 (reversible soft-hide).
  app.get("/api/smart-orders", guard, async (req) => {
    const user = req.user!;
    const includeArchived = (req.query as Record<string, string>)["includeArchived"] === "1";
    const rows = await deps.ruleStore.listByWallet(user.walletAddress, 100, { includeArchived });
    return { strategies: rows.map(serializeStrategy) };
  });

  app.get("/api/smart-orders/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const row = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Smart Order not found" };
    }
    return serializeStrategy(row);
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
      return serializeStrategy(row);
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
    return serializeStrategy(row);
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
      return serializeStrategy(row);
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
      // validator enforces the same structural caps as arm-time.
      const draftDef: StrategyDefinition = {
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
      const structural = validateStrategyDefinition(draftDef).filter((i) =>
        i.code.startsWith("EXPR_"),
      );
      if (structural.length > 0) {
        reply.code(400);
        return { error: "INVALID_STRATEGY", issues: structural };
      }

      const tokens = referencedTokenIds(draftDef);
      const nowMs = Date.now();
      const views = await loadViews(deps, tokens, nowMs, priceMoveTokens(draftDef));
      const evaluation = evaluateExpression(draftDef, views, nowMs);
      return {
        satisfied: evaluation.satisfied,
        root: evaluation.root,
        staleTokenIds: evaluation.staleTokenIds,
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
