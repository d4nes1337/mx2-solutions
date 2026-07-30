import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  MarketSnapshotRow,
  MarketSnapshotStore,
  OrderIntentStore,
  RuleStore,
  RuntimeFlagStore,
  SessionStore,
  TradingAccountClobCredentialStore,
  TradingAccountStore,
  TriggerStore,
} from "@mx2/db";
import {
  bestAsk,
  bestBid,
  conditionLeaves,
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
import {
  makeRequireAuth,
  makeRequireScopedAuth,
  scopeAllowsTrigger,
} from "../middleware/require-auth.js";

export interface RulesRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  orderIntents: OrderIntentStore;
  marketSnapshots: MarketSnapshotStore;
  /** trading_paused kill switch — the trigger detail's tradingEnabled/warning
   * must agree with POST /api/trade/orders, which honors it. */
  runtimeFlags?: RuntimeFlagStore;
  /** Primary-account context for the trigger detail (mobile sign page). */
  tradingAccounts?: TradingAccountStore;
  accountClobCredentials?: TradingAccountClobCredentialStore;
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
 *
 * GTD entry windows anchor to the TRIGGER time: wire expiration =
 * triggeredAtMs + expiresAfterMs + 60s (Polymarket expires GTD orders ~1 min
 * before the stated timestamp — ADR-0013). null expiration = "0" (no expiry).
 */
const buildOrderPreview = (def: StrategyDefinition, config: AppConfig, triggeredAtMs?: number) => {
  if (def.action.kind !== "order") return null;
  const { market, side, price, size, orderType, postOnly, expiresAfterMs, execution } = def.action;
  const expiration =
    orderType === "GTD" && expiresAfterMs !== undefined
      ? Math.floor(((triggeredAtMs ?? Date.now()) + expiresAfterMs + 60_000) / 1000).toString()
      : null;
  return {
    tokenId: market.tokenId,
    conditionId: market.conditionId,
    side,
    price: String(price),
    size: String(size),
    orderType,
    postOnly: postOnly ?? false,
    expiration,
    maxSpend: (price * size).toFixed(6),
    builderCode: config.polymarket.builderCode ?? null,
    signatureType: config.features.privySigning ? 0 : 2,
    executionMode: execution === "auto" ? "auto" : "manual",
    timestamp: Math.floor(Date.now() / 1000).toString(),
  };
};

/** Action Center item state — the honest signing-readiness of a fired trigger. */
type ActionCenterState =
  | "READY_TO_SIGN"
  | "PRICE_MOVED"
  | "WAITING_FOR_FRESH_DATA"
  | "AUTO_EXECUTED";

/** Bounds the batch so a pathological wallet can't produce an unbounded response. */
const ACTION_CENTER_ITEM_CAP = 50;

const centsLabel = (p: number | null | undefined): string | null =>
  p === null || p === undefined ? null : `${Math.round(p * 100)}c`;

/** The order's own price-condition threshold, for "actual vs threshold" display. */
const actionPriceThreshold = (def: StrategyDefinition): number | null => {
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
      return condition.threshold;
    }
  }
  return null;
};

/** Terse, human "why" line for an order strategy (no market data needed). */
const conditionSummary = (def: StrategyDefinition): string => {
  if (def.action.kind !== "order") return def.name;
  const { outcome } = def.action.market;
  const threshold = actionPriceThreshold(def);
  if (threshold !== null) {
    return `${outcome} ${def.action.side === "BUY" ? "at or below" : "at or above"} ${centsLabel(threshold)}`;
  }
  return `${outcome} on ${def.action.market.title ?? "this market"}`;
};

export const registerRulesRoutes = (app: FastifyInstance, deps: RulesRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });
  const requireScopedAuth = makeRequireScopedAuth({ sessions: deps.sessions });

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
  // Trigger preview/confirm/dismiss additionally accept RESTRICTED sessions
  // (sign links, Mini App). Handlers check scopeAllowsTrigger per trigger id.
  const scopedGuard = { preHandler: [requireScopedAuth, requireRulesEnabled] };

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
  // Legacy surface lists v1 rules only; v2 strategies live at /api/strategies.
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
        message: "This strategy uses the v2 engine — evaluate it via /api/strategies.",
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
  app.get("/api/rules/triggers", scopedGuard, async (req, reply) => {
    const user = req.user!;
    // Wallet-wide listing: full sessions and Mini App sessions only — a
    // single-trigger sign link must not enumerate the wallet's other orders.
    if (req.authScope && req.authScope.type !== "telegram_wallet") {
      reply.code(403);
      return { error: "SCOPE_FORBIDDEN", message: "This session cannot list triggers." };
    }
    const triggers = await deps.triggerStore.listAwaiting(user.walletAddress);
    return { triggers };
  });

  // ── GET /api/action-center ──────────────────────────────────────────────────
  // The global Action Center batch (brief §6.4): one wallet-scoped, snapshot-only
  // read of every fired trigger awaiting the user, each resolved to an HONEST
  // signing state (READY_TO_SIGN / PRICE_MOVED / WAITING_FOR_FRESH_DATA). No
  // upstream fan-out in the request path; missing/stale data fails closed to
  // WAITING_FOR_FRESH_DATA. This never signs anything — the single-trigger detail
  // endpoint remains the final FRESH review before a signature.
  //
  // Full sessions only: a restricted sign-link session must not enumerate the
  // wallet's other orders (the `guard` = requireAuth already rejects scoped
  // sessions; this is not on the scopedGuard).
  app.get("/api/action-center", guard, async (req) => {
    const user = req.user!;
    const nowMs = Date.now();
    const awaiting = (await deps.triggerStore.listAwaiting(user.walletAddress)).slice(
      0,
      ACTION_CENTER_ITEM_CAP,
    );

    // One primary-account read for the whole batch (not per item).
    const primary = deps.tradingAccounts
      ? await deps.tradingAccounts.getPrimary(user.walletAddress)
      : null;
    const account = primary ? { label: primary.label } : null;

    // Snapshot cache so shared tokens across triggers are read once.
    const viewByToken = new Map<string, MarketDataView | null>();
    const viewFor = async (tokenId: string): Promise<MarketDataView | null> => {
      if (viewByToken.has(tokenId)) return viewByToken.get(tokenId)!;
      const snapshot = await deps.marketSnapshots.findByTokenId(tokenId);
      const view = snapshot ? snapshotToView(snapshot) : null;
      viewByToken.set(tokenId, view);
      return view;
    };

    const items: unknown[] = [];
    let actionableCount = 0;

    for (const trigger of awaiting) {
      const rule = await deps.ruleStore.findById(trigger.ruleId);
      if (!rule) continue;
      const def = normalizeDefinition(rule.definition as RuleDefinition | StrategyDefinition);
      if (def.action.kind !== "order") continue;
      const action = def.action;

      const views: Record<string, MarketDataView> = {};
      for (const tokenId of referencedTokenIds(def)) {
        const view = await viewFor(tokenId);
        if (view) views[tokenId] = view;
      }
      const evaluation = evaluateExpression(
        def,
        views,
        nowMs,
        (rule.runtimeWatermarks ?? {}) as Parameters<typeof evaluateExpression>[3],
      );

      // Fail-closed state machine: any stale/missing referenced market → WAITING;
      // fresh + condition holds → READY; fresh + no longer holds → PRICE_MOVED.
      const state: ActionCenterState =
        evaluation.staleTokenIds.length > 0
          ? "WAITING_FOR_FRESH_DATA"
          : evaluation.satisfied
            ? "READY_TO_SIGN"
            : "PRICE_MOVED";
      if (state === "READY_TO_SIGN") actionableCount += 1;

      const actionView = views[action.market.tokenId];
      const priceNow = actionView
        ? action.side === "BUY"
          ? bestAsk(actionView)
          : bestBid(actionView)
        : null;
      const dataAgeMs = actionView ? nowMs - actionView.receivedAtMs : null;
      const threshold = actionPriceThreshold(def);

      items.push({
        triggerId: trigger.id,
        ruleId: rule.id,
        ruleName: def.name,
        triggeredAt: trigger.triggeredAt.toISOString(),
        state,
        market: {
          conditionId: action.market.conditionId,
          tokenId: action.market.tokenId,
          title: action.market.title ?? null,
          outcome: action.market.outcome,
        },
        conditionSummary: conditionSummary(def),
        actual: centsLabel(priceNow),
        threshold: centsLabel(threshold),
        dataAgeMs,
        account,
        action: {
          side: action.side,
          sizeShares: action.size,
          price: String(action.price),
          maxSpendUsd: (action.price * action.size).toFixed(2),
          orderType: action.orderType,
        },
        // An auto attempt failed/degraded on this trigger — the UI explains
        // why it is waiting for a signature instead of silently sitting there.
        autoFailed: trigger.autoFailedAt
          ? {
              at: trigger.autoFailedAt.toISOString(),
              reason: trigger.autoFailureReason ?? "unknown",
            }
          : null,
        executed: null,
      });
    }

    // Auto-executed orders (W5 parity): status is confirmed — gone from the
    // awaiting list — but the user hasn't seen them. They stay in the bell
    // until dismissed (acknowledged), surviving reloads and other devices.
    const executedRows = (
      await deps.triggerStore.listUnacknowledgedAutoExecuted(user.walletAddress)
    ).slice(0, ACTION_CENTER_ITEM_CAP);
    let autoExecutedCount = 0;
    for (const trigger of executedRows) {
      const rule = await deps.ruleStore.findById(trigger.ruleId);
      if (!rule) continue;
      const def = normalizeDefinition(rule.definition as RuleDefinition | StrategyDefinition);
      if (def.action.kind !== "order") continue;
      const action = def.action;
      autoExecutedCount += 1;
      items.push({
        triggerId: trigger.id,
        ruleId: rule.id,
        ruleName: def.name,
        triggeredAt: trigger.triggeredAt.toISOString(),
        state: "AUTO_EXECUTED" satisfies ActionCenterState,
        market: {
          conditionId: action.market.conditionId,
          tokenId: action.market.tokenId,
          title: action.market.title ?? null,
          outcome: action.market.outcome,
        },
        conditionSummary: conditionSummary(def),
        actual: null,
        threshold: null,
        dataAgeMs: null,
        account,
        action: {
          side: action.side,
          sizeShares: action.size,
          price: String(action.price),
          maxSpendUsd: (action.price * action.size).toFixed(2),
          orderType: action.orderType,
        },
        autoFailed: null,
        executed: {
          at: (trigger.autoExecutedAt ?? trigger.triggeredAt).toISOString(),
          orderIntentId: trigger.orderIntentId,
        },
      });
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      // Badge counts only items requiring a signature right now (brief §6.5).
      actionableCount,
      // Everything the bell should light up for: signatures needed + executed
      // orders not yet seen. Kept separate so old clients stay correct.
      attentionCount: actionableCount + autoExecutedCount,
      items,
    };
  });

  // ── GET /api/rules/triggers/:id ─────────────────────────────────────────────
  // Trigger + a FRESH preview + whether the condition still holds (docs/04 §6).
  app.get("/api/rules/triggers/:id", scopedGuard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    if (!scopeAllowsTrigger(req.authScope, id)) {
      reply.code(403);
      return { error: "SCOPE_FORBIDDEN", message: "This session cannot access this trigger." };
    }
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
    // The submit route (POST /api/trade/orders) honors the trading_paused kill
    // switch — this preview must never claim ENABLED while submission is
    // blocked, so it combines the flag the same way.
    const paused = (await deps.runtimeFlags?.get("trading_paused"))?.value === "true";
    const tradingEnabled = deps.config.features.liveTrading && !paused;
    // Primary trading-account context: the mobile sign page runs on a
    // RESTRICTED session that cannot call /api/trading-accounts, so the
    // signing addresses it needs ride along here.
    let account: {
      id: string;
      label: string;
      signerAddress: string;
      funderAddress: string | null;
      signingMode: string;
      credentialsReady: boolean;
    } | null = null;
    if (deps.tradingAccounts) {
      const primary = await deps.tradingAccounts.getPrimary(user.walletAddress);
      if (primary) {
        const creds = deps.accountClobCredentials
          ? await deps.accountClobCredentials.find(primary.id)
          : null;
        account = {
          id: primary.id,
          label: primary.label,
          signerAddress: primary.signerAddress,
          funderAddress: primary.funderAddress,
          signingMode: primary.signingMode,
          credentialsReady: creds !== null,
        };
      }
    }
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
      preview: buildOrderPreview(
        def,
        deps.config,
        (trigger.evidence as { triggeredAtMs?: number } | null)?.triggeredAtMs,
      ),
      account,
      tradingEnabled,
      warning: tradingEnabled
        ? "Live trading is ENABLED. Submitting this order will use real funds."
        : "Live trading is DISABLED. This preview is for demonstration only.",
    };
  });

  // ── POST /api/rules/triggers/:id/confirm ────────────────────────────────────
  // Bookkeeping after the user has signed + submitted via POST /api/trade/orders
  // (idempotencyKey "trigger:<id>"). Links the order intent and closes the rule.
  app.post("/api/rules/triggers/:id/confirm", scopedGuard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    if (!scopeAllowsTrigger(req.authScope, id)) {
      reply.code(403);
      return { error: "SCOPE_FORBIDDEN", message: "This session cannot access this trigger." };
    }
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
    // The linked intent must be the caller's own — a foreign id here would
    // otherwise surface someone else's order through the strategy timeline.
    if (orderIntentId) {
      const intent = await deps.orderIntents.findById(orderIntentId);
      if (!intent || intent.walletAddress !== user.walletAddress) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "orderIntentId is not one of your orders." };
      }
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
  app.post("/api/rules/triggers/:id/dismiss", scopedGuard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    if (!scopeAllowsTrigger(req.authScope, id)) {
      reply.code(403);
      return { error: "SCOPE_FORBIDDEN", message: "This session cannot access this trigger." };
    }
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

  // ── POST /api/rules/triggers/:id/ack ────────────────────────────────────────
  // Dismiss an AUTO-EXECUTED card from the bell (W5). Distinct from /dismiss:
  // the trigger is already confirmed — this only marks it seen, cross-device.
  // FULL sessions only (guard, not scopedGuard): a sign-link session must not
  // touch the wallet's bell state.
  app.post("/api/rules/triggers/:id/ack", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    const trigger = await deps.triggerStore.findByIdForWallet(id, user.walletAddress);
    if (!trigger) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trigger not found" };
    }
    if (trigger.acknowledgedAt !== null) {
      return { ok: true, idempotent: true, status: "acknowledged" };
    }
    await deps.triggerStore.acknowledge(id, user.walletAddress);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "rule.trigger.acknowledged",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId: id },
    });
    return { ok: true, status: "acknowledged" };
  });
};
