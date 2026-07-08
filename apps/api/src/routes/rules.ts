import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  MarketSnapshotRow,
  MarketSnapshotStore,
  RuleStore,
  SessionStore,
  TriggerStore,
} from "@mx2/db";
import {
  bestAsk,
  bestBid,
  evaluateExpression,
  evaluatePredicates,
  hashDefinition,
  normalizeDefinition,
  referencedTokenIds,
  spread,
  type BookLevel,
  type MarketDataView,
  type RuleDefinition,
  type StrategyDefinition,
} from "@mx2/rules";
import { makeRequireAuth } from "../middleware/require-auth.js";

export interface RulesRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  marketSnapshots: MarketSnapshotStore;
}

// ── Request validation ────────────────────────────────────────────────────────

const PredicateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price"),
    source: z.enum(["ask", "bid"]),
    comparator: z.enum(["lte", "gte"]),
    threshold: z.number().gt(0).lt(1),
  }),
  z.object({
    kind: z.literal("cumulative_notional"),
    source: z.enum(["ask", "bid"]),
    priceBound: z.number().gt(0).lt(1),
    minNotional: z.number().positive(),
  }),
  z.object({
    kind: z.literal("visible_levels"),
    source: z.enum(["ask", "bid"]),
    priceBound: z.number().gt(0).lt(1),
    minLevels: z.number().int().positive(),
  }),
]);

const ActionSchema = z.object({
  kind: z.literal("prepare_order"),
  side: z.enum(["BUY", "SELL"]),
  price: z.number().gt(0).lt(1),
  size: z.number().positive(),
  orderType: z.literal("GTC"),
});

const CreateRuleSchema = z.object({
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  predicates: z.array(PredicateSchema).min(1).max(8),
  continuousWindowMs: z.number().int().positive().max(86_400_000).default(600_000),
  maxDataAgeMs: z.number().int().positive().max(60_000).default(2_000),
  action: ActionSchema,
  expiresAt: z.string().datetime().nullish(),
  // "auto" lets the worker submit on trigger with no human (only takes effect when
  // FEATURE_CONDITIONAL_LIVE_EXECUTION is on; otherwise it degrades to manual).
  executionMode: z.enum(["manual", "auto"]).default("manual"),
  // Market metadata needed to build a correct auto-signed order.
  negRisk: z.boolean().default(false),
  tickSize: z.enum(["0.1", "0.01", "0.001", "0.0001"]).optional(),
});

// ── Snapshot → normalized view ────────────────────────────────────────────────

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

/** Evaluate a rule definition against the latest snapshot for its token. */
const evaluateAgainstSnapshot = (
  def: RuleDefinition,
  snapshot: MarketSnapshotRow | null,
  nowMs: number,
) => {
  if (!snapshot) {
    return { hasData: false as const, isStale: true, dataAgeMs: null, satisfied: false };
  }
  const view = snapshotToView(snapshot);
  const dataAgeMs = nowMs - view.receivedAtMs;
  const isStale = snapshot.isStale || dataAgeMs > def.maxDataAgeMs;
  const evaluation = evaluatePredicates(def, view);
  return {
    hasData: true as const,
    isStale,
    dataAgeMs,
    satisfied: evaluation.satisfied && !isStale,
    predicates: evaluation.results,
    bestBid: bestBid(view),
    bestAsk: bestAsk(view),
    spread: spread(view),
  };
};

/**
 * Order parameters the user is asked to confirm + sign (mirrors trade preview).
 * Works on the normalized v2 shape so v1 and v2 triggers share one confirm flow;
 * returns null for actions with nothing to sign (alert / stop_strategy).
 */
const buildOrderPreview = (def: StrategyDefinition, config: AppConfig) => {
  if (def.action.kind !== "order") return null;
  const { market, side, price, size, orderType, execution } = def.action;
  return {
    tokenId: market.tokenId,
    conditionId: market.conditionId,
    side,
    price: String(price),
    size: String(size),
    orderType,
    maxSpend: (price * size).toFixed(6),
    builderCode: config.polymarket.builderCode ?? null,
    signatureType: config.features.privySigning ? 0 : 2,
    executionMode: execution === "auto" ? "auto" : "manual",
    timestamp: Math.floor(Date.now() / 1000).toString(),
  };
};

export const registerRulesRoutes = (app: FastifyInstance, deps: RulesRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  // Fail-closed gate: the whole feature is behind FEATURE_CONDITIONAL_RULES.
  const requireRulesEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.conditionalRules) {
      await reply.code(503).send({
        error: "CONDITIONAL_RULES_DISABLED",
        message: "Conditional rules are disabled on this server.",
      });
    }
  };

  const guard = { preHandler: [requireAuth, requireRulesEnabled] };

  // ── POST /api/rules ─────────────────────────────────────────────────────────
  app.post("/api/rules", guard, async (req, reply) => {
    const user = req.user!;
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const b = parsed.data;
    const expiresAtMs = b.expiresAt ? new Date(b.expiresAt).getTime() : null;
    const definition: RuleDefinition = {
      version: 1,
      tokenId: b.tokenId,
      conditionId: b.conditionId,
      outcomeSide: b.side,
      predicates: b.predicates,
      continuousWindowMs: b.continuousWindowMs,
      maxDataAgeMs: b.maxDataAgeMs,
      action: b.action,
      recurrence: "once",
      expiresAtMs,
      executionMode: b.executionMode,
      negRisk: b.negRisk,
      ...(b.tickSize ? { tickSize: b.tickSize } : {}),
    };
    const definitionHash = hashDefinition(definition);
    const rule = await deps.ruleStore.create({
      walletAddress: user.walletAddress,
      conditionId: b.conditionId,
      tokenId: b.tokenId,
      side: b.side,
      definition,
      definitionHash,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs),
    });
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.created",
      subject: `rule:${rule.id}`,
      metadata: {
        tokenId: b.tokenId,
        side: b.side,
        definitionHash,
        predicateCount: b.predicates.length,
        continuousWindowMs: b.continuousWindowMs,
        executionMode: b.executionMode,
      },
    });
    reply.code(201);
    return rule;
  });

  // ── GET /api/rules ──────────────────────────────────────────────────────────
  // Legacy surface lists v1 rules only; v2 strategies live at /api/smart-orders.
  app.get("/api/rules", guard, async (req) => {
    const user = req.user!;
    const rules = await deps.ruleStore.listByWallet(user.walletAddress);
    return { rules: rules.filter((r) => r.version === 1) };
  });

  // ── GET /api/rules/:id ──────────────────────────────────────────────────────
  app.get("/api/rules/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const rule = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!rule) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Rule not found" };
    }
    return rule;
  });

  // ── GET /api/rules/:id/evaluate-now ─────────────────────────────────────────
  // Read-only "would this trigger right now?" against the latest snapshot.
  app.get("/api/rules/:id/evaluate-now", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const rule = await deps.ruleStore.findByIdForWallet(id, user.walletAddress);
    if (!rule) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Rule not found" };
    }
    if (rule.version !== 1) {
      reply.code(409);
      return {
        error: "USE_SMART_ORDERS",
        message: "This strategy uses the v2 engine — evaluate it via /api/smart-orders.",
      };
    }
    const def = rule.definition as RuleDefinition;
    const snapshot = await deps.marketSnapshots.findByTokenId(rule.tokenId);
    const evaluation = evaluateAgainstSnapshot(def, snapshot, Date.now());
    return {
      ruleId: rule.id,
      status: rule.status,
      maxDataAgeMs: def.maxDataAgeMs,
      continuousWindowMs: def.continuousWindowMs,
      ...evaluation,
    };
  });

  // ── Control transitions ─────────────────────────────────────────────────────
  const control = (
    action: "pause" | "resume" | "cancel",
    fn: (id: string, wallet: string) => Promise<unknown>,
  ) =>
    app.post(`/api/rules/:id/${action}`, guard, async (req, reply) => {
      const user = req.user!;
      const { id } = req.params as { id: string };
      const row = await fn(id, user.walletAddress);
      if (!row) {
        reply.code(409);
        return {
          error: "INVALID_STATE",
          message: `Rule cannot be ${action}d in its current state.`,
        };
      }
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${id}`,
        metadata: { control: action },
      });
      return row;
    });

  control("pause", (id, w) => deps.ruleStore.pause(id, w));
  control("resume", (id, w) => deps.ruleStore.resume(id, w));
  // DELETE is the RESTful cancel; also expose POST .../cancel for symmetry.
  control("cancel", (id, w) => deps.ruleStore.cancel(id, w));
  app.delete("/api/rules/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const row = await deps.ruleStore.cancel(id, user.walletAddress);
    if (!row) {
      reply.code(409);
      return { error: "INVALID_STATE", message: "Rule cannot be cancelled in its current state." };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.state_changed",
      subject: `rule:${id}`,
      metadata: { control: "cancel" },
    });
    return { ok: true };
  });

  // ── GET /api/rules/triggers ─────────────────────────────────────────────────
  app.get("/api/rules/triggers", guard, async (req) => {
    const user = req.user!;
    const triggers = await deps.triggerStore.listAwaiting(user.walletAddress);
    return { triggers };
  });

  // ── GET /api/rules/triggers/:id ─────────────────────────────────────────────
  // Trigger + a FRESH preview + whether the condition still holds (docs/04 §6).
  app.get("/api/rules/triggers/:id", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const trigger = await deps.triggerStore.findByIdForWallet(id, user.walletAddress);
    if (!trigger) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trigger not found" };
    }
    const rule = await deps.ruleStore.findById(trigger.ruleId);
    if (!rule) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Originating rule not found" };
    }
    // Normalize so v1 and v2 triggers share one confirm flow. Freshness reads
    // worker snapshots for every referenced market; a missing/stale snapshot
    // yields conditionStillHolds=false (fail-closed), matching the evaluator.
    const def = normalizeDefinition(rule.definition as RuleDefinition | StrategyDefinition);
    const nowMs = Date.now();
    const views: Record<string, MarketDataView> = {};
    for (const tokenId of referencedTokenIds(def)) {
      const snapshot = await deps.marketSnapshots.findByTokenId(tokenId);
      if (snapshot) views[tokenId] = snapshotToView(snapshot);
    }
    const evaluation = evaluateExpression(def, views, nowMs);
    return {
      trigger,
      evidence: trigger.evidence,
      conditionStillHolds: evaluation.satisfied,
      fresh: {
        satisfied: evaluation.satisfied,
        isStale: evaluation.staleTokenIds.length > 0,
        root: evaluation.root,
        staleTokenIds: evaluation.staleTokenIds,
      },
      preview: buildOrderPreview(def, deps.config),
      warning: deps.config.features.liveTrading
        ? "Live trading is ENABLED. Submitting this order will use real funds."
        : "Live trading is DISABLED. This preview is for demonstration only.",
    };
  });

  // ── POST /api/rules/triggers/:id/confirm ────────────────────────────────────
  // Bookkeeping after the user has signed + submitted via POST /api/trade/orders
  // (idempotencyKey "trigger:<id>"). Links the order intent and closes the rule.
  app.post("/api/rules/triggers/:id/confirm", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderIntentId =
      typeof body["orderIntentId"] === "string" ? body["orderIntentId"] : undefined;

    const trigger = await deps.triggerStore.findByIdForWallet(id, user.walletAddress);
    if (!trigger) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trigger not found" };
    }
    if (trigger.status !== "awaiting_user") {
      return { ok: true, idempotent: true, status: trigger.status };
    }
    await deps.triggerStore.updateStatus(
      id,
      "confirmed",
      orderIntentId ? { orderIntentId } : undefined,
    );
    await deps.ruleStore.markExecuted(trigger.ruleId, user.walletAddress);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.trigger.confirmed",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId: id, orderIntentId: orderIntentId ?? null },
    });
    return { ok: true, status: "confirmed" };
  });

  // ── POST /api/rules/triggers/:id/dismiss ────────────────────────────────────
  app.post("/api/rules/triggers/:id/dismiss", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const trigger = await deps.triggerStore.findByIdForWallet(id, user.walletAddress);
    if (!trigger) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trigger not found" };
    }
    if (trigger.status !== "awaiting_user") {
      return { ok: true, idempotent: true, status: trigger.status };
    }
    await deps.triggerStore.updateStatus(id, "dismissed");
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.trigger.dismissed",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId: id },
    });
    return { ok: true, status: "dismissed" };
  });
};
