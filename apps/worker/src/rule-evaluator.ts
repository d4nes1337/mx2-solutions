import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  NotificationOutboxStore,
  RuleStore,
  TriggerStore,
  ConditionalRuleRow,
} from "@mx2/db";
import {
  conditionLeaves,
  isTerminal,
  normalizeDefinition,
  referencedTokenIds,
  staleGraceMsOf,
  transitionV2,
  type EvalEventV2,
  type MarketDataView,
  type RuleDefinition,
  type StrategyDefinition,
  type StrategyRuntime,
  type TransitionResultV2,
  type ViewsByToken,
  type WatermarksByNode,
} from "@mx2/rules";
import type { AutoExecutor } from "./auto-executor.js";
import { createPriceWindowStore } from "./price-window.js";

/** Content equality for watermark maps (per-node value, not identity). */
const watermarksEqual = (a: WatermarksByNode = {}, b: WatermarksByNode = {}): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => b[k] !== undefined && a[k]!.value === b[k]!.value);
};

/**
 * Single-writer conditional-rule evaluator (L3 host). Lives in the worker so a
 * rule's deterministic state machine has exactly one writer. It:
 *   - periodically reloads the evaluable rule set from the DB,
 *   - drives WS subscriptions for EVERY token a strategy references (v2 rules
 *     may watch several markets),
 *   - feeds each rule book/tick/reconnect/tick-size events, and
 *   - persists state changes + writes a rule_triggers row on a trigger.
 *
 * v1 and v2 definitions run through ONE evaluation path: stored definitions are
 * read via normalizeDefinition (compat.ts) and evaluated by transitionV2; the
 * v1-parity test suite in @mx2/rules proves behavioral equivalence. Evidence
 * hashes use the stored definition_hash column, so v1 triggers stay tied to the
 * original v1 JSON.
 *
 * DB writes use compare-and-set (RuleStore.updateEvaluationState) so a
 * concurrent user pause/cancel wins.
 *
 * Deferred seam: a single worker satisfies single-writer today (D-001). For
 * multi-instance, take a Postgres advisory lock / lease per rule before owning
 * it — see docs/adr/0005 and RISK register.
 */
export interface RuleEvaluatorManager {
  start(): void;
  onBook(view: MarketDataView): void;
  /**
   * price_change level deltas: patch the cached book view AND refresh its
   * freshness clock. Without this, a live-but-quiet market only refreshes on
   * full `book` snapshots and hold windows keep resetting as "stale".
   */
  onBookDelta(tokenId: string, deltas: readonly BookLevelDelta[], tMs: number): void;
  /**
   * Freshness heartbeat with no level info (e.g. last_trade_price). Honest
   * tradeoff: the book may have shifted on the trade, but upstream sends
   * book/price_change alongside trades, and the tolerance is the same accuracy
   * budget maxDataAgeMs already accepts.
   */
  onHeartbeat(tokenId: string, tMs: number): void;
  /** Price print/tick/mid — feeds rolling price_move windows. */
  onPrice(tokenId: string, price: number, tMs: number): void;
  onReconnect(): void;
  onTickSizeChange(tokenId: string): void;
  stop(): void;
}

/** One orderbook level change (size 0 = level removed). */
export interface BookLevelDelta {
  readonly price: number;
  readonly size: number;
  readonly side: "bid" | "ask";
}

export interface RuleEvaluatorOptions {
  logger: Logger;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  auditStore: AuditStore;
  subscribe: (tokenIds: string[]) => void;
  unsubscribe: (tokenIds: string[]) => void;
  /**
   * Auto-execution handler. Provided ONLY when FEATURE_CONDITIONAL_LIVE_EXECUTION
   * is enabled. When present, "auto" rules build+sign+submit on trigger; when
   * absent (the default), every rule degrades to manual confirmation.
   */
  autoExecutor?: AutoExecutor;
  /**
   * Notification outbox (FEATURE_NOTIFICATIONS). When present, alert triggers
   * and orders parked at awaiting_user enqueue an external notification —
   * idempotent by dedupe key, so a re-evaluated trigger never double-notifies.
   */
  outbox?: NotificationOutboxStore;
  /** How often to reconcile the active rule set from the DB. Default 5 s. */
  reloadIntervalMs?: number;
  /** How often to tick rules for staleness / window completion. Default 1 s. */
  tickIntervalMs?: number;
  /**
   * REST orderbook fetch for the background freshness-verify pass. When a
   * subscribed token's view is aging while the WS transport is healthy, the
   * evaluator re-fetches the book instead of letting the view go stale.
   * Absent → no REST verification (WS-only freshness).
   */
  fetchOrderbook?: (tokenId: string) => Promise<MarketDataView | null>;
  /**
   * WS transport liveness. REST verification runs ONLY while this returns
   * true — a real disconnect must still fail closed (DATA_STALE resets).
   */
  isFeedConnected?: () => boolean;
  /** Cadence of the REST freshness-verify pass. Default 10 s. */
  refreshIntervalMs?: number;
  /** Max tokens re-fetched per verify pass (CLOB load bound). Default 8. */
  refreshMaxPerPass?: number;
  /** Min gap between audited churn events per (rule, reason). Default 60 s. */
  churnAuditMinIntervalMs?: number;
}

interface ActiveRule {
  readonly id: string;
  readonly walletAddress: string;
  /** User-facing strategy name (v2 rows; null for legacy v1). */
  readonly name: string | null;
  /** Primary token (order market for v2; the single token for v1 rows). */
  readonly tokenId: string;
  /** Every token the strategy references — its subscription set. */
  readonly tokens: readonly string[];
  /** Tokens referenced by price_move leaves — get priceHistory attached. */
  readonly moveTokens: ReadonlySet<string>;
  readonly def: StrategyDefinition;
  /** Hash of the ORIGINAL stored definition (ties evidence to the stored JSON). */
  readonly defHash: string;
  runtime: StrategyRuntime;
  /** Serializes DB writes per rule so persisted status reflects event order. */
  writeChain: Promise<void>;
}

export const createRuleEvaluatorManager = (opts: RuleEvaluatorOptions): RuleEvaluatorManager => {
  const {
    logger,
    ruleStore,
    triggerStore,
    auditStore,
    subscribe,
    unsubscribe,
    autoExecutor,
    outbox,
  } = opts;
  const reloadIntervalMs = opts.reloadIntervalMs ?? 5_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 1_000;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 10_000;
  const refreshMaxPerPass = opts.refreshMaxPerPass ?? 32;
  const churnAuditMinIntervalMs = opts.churnAuditMinIntervalMs ?? 60_000;

  const rules = new Map<string, ActiveRule>();
  const tokenSubs = new Map<string, Set<string>>();
  const latestView = new Map<string, MarketDataView>();
  const priceWindows = createPriceWindowStore();
  /** Last audited churn event per `${ruleId}:${reason}` (rate limit). */
  const churnAuditAt = new Map<string, number>();
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshCursor = 0;
  /** Per-token single-flight: a hung fetch must not block later passes. */
  const refreshInFlightTokens = new Set<string>();
  /** Per-token error backoff: skip a failing token until this timestamp. */
  const refreshBackoffUntil = new Map<string, number>();

  const addRule = (row: ConditionalRuleRow): void => {
    let def: StrategyDefinition;
    try {
      def = normalizeDefinition(row.definition as RuleDefinition | StrategyDefinition);
    } catch (e) {
      logger.warn({ err: e, ruleId: row.id }, "Skipping rule with unparseable definition");
      return;
    }
    // Maker loops are the QuoterManager's rows — the trigger state machine
    // does not apply to them (ADR-0014).
    if (def.action.kind === "quote_loop") return;
    const tokens = referencedTokenIds(def);
    const moveTokens = new Set<string>(
      conditionLeaves(def.expr)
        .filter((l) => l.condition.kind === "price_move")
        .map((l) => (l.condition.kind === "price_move" ? l.condition.market.tokenId : ""))
        .filter((t) => t !== ""),
    );
    // Restart policy: resume a mid-accumulation hold window ONLY when the
    // downtime still fits the rule's stale budget (maxDataAgeMs + stale
    // grace) — the same tolerance a live pause gets. A longer gap means we
    // cannot vouch the condition held while we were down, so we
    // conservatively restart the window (and audit the reset so the timeline
    // shows why). Repeat bookkeeping (triggerCount, cooldownUntil) and
    // trailing watermarks are ALWAYS preserved (D-025: a trailing stop keeps
    // protecting through a restart; resetting the peak on every restart
    // would walk the stop level down a decline).
    const canResume =
      row.status === "ACTIVE_ACCUMULATING" &&
      row.trueSince !== null &&
      row.lastEvaluatedAt !== null &&
      Date.now() - row.lastEvaluatedAt.getTime() <= def.maxDataAgeMs + staleGraceMsOf(def);
    const runtime: StrategyRuntime = {
      status: canResume ? "ACTIVE_ACCUMULATING" : "ACTIVE_WAITING",
      trueSinceMs: canResume ? row.trueSince!.getTime() : null,
      lastEventTimeMs: null,
      triggerCount: row.triggerCount ?? 0,
      cooldownUntilMs: row.cooldownUntil ? row.cooldownUntil.getTime() : null,
      watermarks: (row.runtimeWatermarks as WatermarksByNode | null) ?? {},
      // A persisted pause resumes as a pause: the grace keeps counting from
      // the ORIGINAL onset, so a restart can't extend the stale budget.
      staleSinceMs: canResume && row.staleSince ? row.staleSince.getTime() : null,
    };
    if (!canResume && row.status === "ACTIVE_ACCUMULATING") {
      auditStore
        .emit({
          actor: row.walletAddress,
          action: "rule.state_changed",
          subject: `rule:${row.id}`,
          metadata: {
            from: "ACTIVE_ACCUMULATING",
            to: "ACTIVE_WAITING",
            reason: "RESTART_RESET",
            nonTerminal: true,
          },
        })
        .catch((e: unknown) =>
          logger.warn({ err: e, ruleId: row.id }, "Restart-reset audit failed"),
        );
    }
    rules.set(row.id, {
      id: row.id,
      walletAddress: row.walletAddress,
      name: row.name,
      tokenId: row.tokenId,
      tokens,
      moveTokens,
      def,
      defHash: row.definitionHash,
      runtime,
      writeChain: Promise.resolve(),
    });
    for (const token of tokens) {
      let set = tokenSubs.get(token);
      if (!set) {
        set = new Set();
        tokenSubs.set(token, set);
        subscribe([token]);
      }
      set.add(row.id);
    }
  };

  const removeRule = (id: string): void => {
    const ar = rules.get(id);
    if (!ar) return;
    rules.delete(id);
    for (const key of [...churnAuditAt.keys()]) {
      if (key.startsWith(`${id}:`)) churnAuditAt.delete(key);
    }
    for (const token of ar.tokens) {
      const set = tokenSubs.get(token);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) {
        tokenSubs.delete(token);
        latestView.delete(token);
        priceWindows.drop(token);
        unsubscribe([token]);
      }
    }
  };

  const reload = async (): Promise<void> => {
    const rows = await ruleStore.listEvaluable();
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      if (!rules.has(row.id)) addRule(row);
    }
    for (const id of [...rules.keys()]) {
      if (!seen.has(id)) removeRule(id);
    }
  };

  /**
   * Current views for every token the rule references (missing entries stay
   * absent). Rolling price history is attached only for tokens this rule's
   * price_move leaves read — other rules keep the bare (cheaper) views.
   */
  const viewsFor = (ar: ActiveRule): ViewsByToken => {
    const views: Record<string, MarketDataView> = {};
    for (const token of ar.tokens) {
      const v = latestView.get(token);
      if (!v) continue;
      if (ar.moveTokens.has(token)) {
        const priceHistory = priceWindows.history(token);
        views[token] = priceHistory ? { ...v, priceHistory } : v;
      } else {
        views[token] = v;
      }
    }
    return views;
  };

  const persist = async (
    ar: ActiveRule,
    result: TransitionResultV2,
    nowMs: number,
  ): Promise<void> => {
    const updated = await ruleStore.updateEvaluationState(ar.id, {
      status: result.runtime.status,
      trueSinceMs: result.runtime.trueSinceMs,
      lastEvaluatedAt: new Date(nowMs),
      triggerCount: result.runtime.triggerCount,
      cooldownUntilMs: result.runtime.cooldownUntilMs,
      watermarks: result.runtime.watermarks ?? {},
      staleSinceMs: result.runtime.staleSinceMs ?? null,
    });
    if (!updated) {
      // The rule was concurrently controlled (paused/cancelled) — user wins.
      removeRule(ar.id);
      return;
    }

    if (result.trigger) {
      // Defensive single-trigger guard (once-recurrence only; repeat strategies
      // legitimately produce one trigger per repetition).
      const duplicate = ar.def.recurrence.kind === "once" && (await triggerStore.hasForRule(ar.id));
      if (!duplicate) {
        const action = ar.def.action;
        const isAuto =
          autoExecutor !== undefined && action.kind === "order" && action.execution === "auto";
        const trig = await triggerStore.create({
          ruleId: ar.id,
          walletAddress: ar.walletAddress,
          evidence: result.trigger,
          reasonCodes: result.trigger.reasonCodes,
          status: action.kind === "alert" ? "notified" : "awaiting_user",
        });
        await auditStore.emit({
          actor: ar.walletAddress,
          action: "rule.triggered",
          subject: `rule:${ar.id}`,
          metadata: {
            triggerId: trig.id,
            actionKind: action.kind,
            executionMode: isAuto ? "auto" : action.kind === "order" ? "manual" : "alert",
            triggerNumber: result.trigger.triggerNumber,
            windowStartMs: result.trigger.windowStartMs,
            triggeredAtMs: result.trigger.triggeredAtMs,
            bestAsk: result.trigger.bestAsk,
            bestBid: result.trigger.bestBid,
          },
        });

        // External notification (FEATURE_NOTIFICATIONS). Idempotent by dedupe
        // key; failures never block the trigger — the row already exists and
        // the in-app surface still shows it.
        if (outbox && (action.kind === "alert" || (action.kind === "order" && !isAuto))) {
          try {
            if (action.kind === "alert") {
              await outbox.enqueue({
                walletAddress: ar.walletAddress,
                kind: "rule_alert",
                dedupeKey: `trigger:${trig.id}:alert`,
                payload: {
                  triggerId: trig.id,
                  ruleId: ar.id,
                  ruleName: ar.name,
                  bestBid: result.trigger.bestBid ?? null,
                  bestAsk: result.trigger.bestAsk ?? null,
                },
              });
            } else {
              await outbox.enqueue({
                walletAddress: ar.walletAddress,
                kind: "order_awaiting_signature",
                dedupeKey: `trigger:${trig.id}:sign`,
                payload: {
                  triggerId: trig.id,
                  ruleId: ar.id,
                  ruleName: ar.name,
                  side: action.side,
                  price: action.price,
                  size: action.size,
                  orderType: action.orderType,
                  bestBid: result.trigger.bestBid ?? null,
                  bestAsk: result.trigger.bestAsk ?? null,
                },
              });
            }
          } catch (e) {
            logger.warn({ err: e, triggerId: trig.id }, "notification enqueue failed");
          }
        }

        if (action.kind === "stop_strategy") {
          // The strategy's whole purpose is stopping another one — do it now,
          // scoped to the same wallet so it can never touch other users' rules.
          const stopped = await ruleStore.cancel(action.targetStrategyId, ar.walletAddress);
          await auditStore.emit({
            actor: ar.walletAddress,
            action: "rule.state_changed",
            subject: `rule:${action.targetStrategyId}`,
            metadata: {
              control: "cancel",
              by: `rule:${ar.id}`,
              applied: stopped !== null,
            },
          });
        } else if (isAuto) {
          logger.info(
            { ruleId: ar.id, triggerId: trig.id },
            "Conditional rule triggered — auto-executing",
          );
          // Build + sign + submit with fail-closed guards. Runs in the per-rule
          // writeChain so it is serialized with all other state for this rule.
          await autoExecutor.execute({
            rule: {
              id: ar.id,
              walletAddress: ar.walletAddress,
              tokenId: ar.tokenId,
              def: ar.def,
            },
            triggerId: trig.id,
            evidence: result.trigger,
            nowMs,
          });
        } else if (action.kind === "order") {
          logger.info(
            { ruleId: ar.id, triggerId: trig.id },
            "Conditional rule triggered — awaiting manual confirmation (no auto-submit)",
          );
        } else {
          logger.info(
            { ruleId: ar.id, triggerId: trig.id, triggerNumber: result.trigger.triggerNumber },
            "Conditional rule triggered — alert recorded",
          );
        }
      }
    }

    // Terminal transitions are always audited. Non-terminal churn (window
    // started, stale/price resets, reconnects…) is audited too — it is what a
    // strategy's activity timeline is made of, and its absence is exactly how
    // the "hold window silently reset for 15 minutes" failure stayed invisible
    // — but rate-limited per (rule, reason) so a flapping market can't flood
    // the append-only log. TRIGGERED transitions are excluded: rule.triggered
    // already records those with full evidence.
    if (result.transition && result.transition.to !== "TRIGGERED_AWAITING_USER") {
      const isTerminalTransition = isTerminal(result.transition.to);
      const churnKey = `${ar.id}:${result.transition.reason}`;
      const lastAt = churnAuditAt.get(churnKey) ?? 0;
      if (isTerminalTransition || nowMs - lastAt >= churnAuditMinIntervalMs) {
        if (!isTerminalTransition) churnAuditAt.set(churnKey, nowMs);
        await auditStore.emit({
          actor: ar.walletAddress,
          action: "rule.state_changed",
          subject: `rule:${ar.id}`,
          metadata: {
            from: result.transition.from,
            to: result.transition.to,
            reason: result.transition.reason,
            ...(isTerminalTransition
              ? {}
              : { trueSinceMs: result.runtime.trueSinceMs, nonTerminal: true }),
          },
        });
      }
    }

    if (isTerminal(result.runtime.status)) removeRule(ar.id);
  };

  /** Re-evaluate every rule watching `tokenId` against the current views. */
  const reevaluateToken = (tokenId: string): void => {
    const set = tokenSubs.get(tokenId);
    if (!set) return;
    const now = Date.now();
    for (const id of [...set]) {
      const ar = rules.get(id);
      if (ar) applyEvent(ar, { type: "book", views: viewsFor(ar), nowMs: now });
    }
  };

  /** Patch a cached view with level deltas and stamp it fresh. */
  const applyDeltas = (
    view: MarketDataView,
    deltas: readonly BookLevelDelta[],
    tMs: number,
  ): MarketDataView => {
    let bids = view.bids;
    let asks = view.asks;
    for (const d of deltas) {
      const current = d.side === "bid" ? bids : asks;
      const without = current.filter((l) => l.price !== d.price);
      const next = d.size > 0 ? [...without, { price: d.price, size: d.size }] : without;
      next.sort((a, b) => (d.side === "bid" ? b.price - a.price : a.price - b.price));
      if (d.side === "bid") bids = next;
      else asks = next;
    }
    return { ...view, bids, asks, sourceTimeMs: tMs, receivedAtMs: tMs };
  };

  /**
   * Background freshness verification: while the WS transport is healthy,
   * re-fetch the book for subscribed tokens whose view is aging past half the
   * tightest maxDataAgeMs of the rules watching them. On a quiet market the WS
   * legitimately sends nothing (deltas only on change), so without this pass
   * long hold windows would keep resetting as "stale". A real disconnect
   * skips the pass entirely — staleness then fails closed as before.
   */
  const refreshQuietTokens = async (): Promise<void> => {
    const { fetchOrderbook, isFeedConnected } = opts;
    if (!fetchOrderbook || isFeedConnected?.() !== true) return;
    const now = Date.now();
    // Two-tier priority: a token whose rule is mid-dwell (ACTIVE_ACCUMULATING)
    // must never lose its hold window to the per-pass fetch bound — those
    // fetch first, every pass. Idle tokens take the remaining budget on a
    // round-robin cursor.
    const urgent: string[] = [];
    const idle: string[] = [];
    for (const [token, ruleIds] of tokenSubs) {
      if (refreshInFlightTokens.has(token)) continue;
      if ((refreshBackoffUntil.get(token) ?? 0) > now) continue;
      let minAge = Infinity;
      let accumulating = false;
      for (const id of ruleIds) {
        const ar = rules.get(id);
        if (!ar) continue;
        minAge = Math.min(minAge, ar.def.maxDataAgeMs);
        if (ar.runtime.status === "ACTIVE_ACCUMULATING") accumulating = true;
      }
      const threshold = Number.isFinite(minAge) ? minAge / 2 : 15_000;
      const view = latestView.get(token);
      const age = view ? now - view.sourceTimeMs : Infinity;
      if (age <= threshold) continue;
      (accumulating ? urgent : idle).push(token);
    }
    if (urgent.length === 0 && idle.length === 0) return;
    const idleBudget = Math.max(0, refreshMaxPerPass - urgent.length);
    const start = idle.length > 0 ? refreshCursor % idle.length : 0;
    const idleBatch = [...idle.slice(start), ...idle.slice(0, start)].slice(0, idleBudget);
    refreshCursor += idleBatch.length;
    const batch = [...urgent, ...idleBatch];
    for (const token of batch) refreshInFlightTokens.add(token);
    await Promise.all(
      batch.map(async (token) => {
        try {
          const view = await fetchOrderbook(token);
          refreshBackoffUntil.delete(token);
          if (!view || !tokenSubs.has(token)) return;
          const current = latestView.get(token);
          // Never regress: WS may have delivered newer data mid-fetch.
          if (current && current.sourceTimeMs >= view.sourceTimeMs) return;
          latestView.set(token, view);
          reevaluateToken(token);
        } catch (e) {
          refreshBackoffUntil.set(token, Date.now() + 15_000);
          logger.warn({ err: e, tokenId: token }, "REST freshness re-fetch failed");
        } finally {
          refreshInFlightTokens.delete(token);
        }
      }),
    );
  };

  const applyEvent = (ar: ActiveRule, event: EvalEventV2): void => {
    const result = transitionV2(ar.def, ar.defHash, ar.runtime, event);
    const runtimeChanged =
      result.runtime.triggerCount !== ar.runtime.triggerCount ||
      result.runtime.cooldownUntilMs !== ar.runtime.cooldownUntilMs ||
      // Pause onset/clear must persist even without a status change, so a
      // worker restart mid-pause keeps the original stale-grace accounting.
      (result.runtime.staleSinceMs ?? null) !== (ar.runtime.staleSinceMs ?? null) ||
      // Content compare, not identity — the evaluator returns a fresh map per
      // pass. Write volume is bounded by actual watermark movement.
      !watermarksEqual(result.runtime.watermarks, ar.runtime.watermarks);
    ar.runtime = result.runtime;
    if (!result.transition && !result.trigger && !runtimeChanged) return;
    ar.writeChain = ar.writeChain
      .then(() => persist(ar, result, event.nowMs))
      .catch((e: unknown) => logger.warn({ err: e, ruleId: ar.id }, "Rule persist failed"));
  };

  return {
    start() {
      reload().catch((e: unknown) => logger.warn({ err: e }, "Initial rule reload failed"));
      reloadTimer = setInterval(() => {
        reload().catch((e: unknown) => logger.warn({ err: e }, "Rule reload failed"));
      }, reloadIntervalMs);
      tickTimer = setInterval(() => {
        const now = Date.now();
        for (const ar of rules.values()) {
          const views = viewsFor(ar);
          applyEvent(ar, {
            type: "tick",
            views: Object.keys(views).length > 0 ? views : null,
            nowMs: now,
          });
        }
      }, tickIntervalMs);
      if (opts.fetchOrderbook) {
        refreshTimer = setInterval(() => {
          refreshQuietTokens().catch((e: unknown) =>
            logger.warn({ err: e }, "Freshness verify pass failed"),
          );
        }, refreshIntervalMs);
      }
      logger.info(
        { reloadIntervalMs, tickIntervalMs, restVerify: Boolean(opts.fetchOrderbook) },
        "Conditional-rule evaluator started",
      );
    },

    onBook(view) {
      latestView.set(view.tokenId, view);
      reevaluateToken(view.tokenId);
    },

    onBookDelta(tokenId, deltas, tMs) {
      const view = latestView.get(tokenId);
      // No cached snapshot → never fabricate a book from deltas alone.
      if (!view) return;
      latestView.set(tokenId, applyDeltas(view, deltas, tMs));
      reevaluateToken(tokenId);
    },

    onHeartbeat(tokenId, tMs) {
      const view = latestView.get(tokenId);
      if (!view || view.sourceTimeMs >= tMs) return;
      latestView.set(tokenId, { ...view, sourceTimeMs: tMs, receivedAtMs: tMs });
      // No re-evaluation: nothing changed but the clock; the 1 s tick covers it.
    },

    onPrice(tokenId, price, tMs) {
      priceWindows.push(tokenId, price, tMs);
      const set = tokenSubs.get(tokenId);
      if (!set) return;
      const now = Date.now();
      for (const id of [...set]) {
        const ar = rules.get(id);
        // Only rules whose price_move reads this token need a re-evaluation —
        // for everything else the periodic tick covers it.
        if (!ar || !ar.moveTokens.has(tokenId)) continue;
        const views = viewsFor(ar);
        applyEvent(ar, {
          type: "tick",
          views: Object.keys(views).length > 0 ? views : null,
          nowMs: now,
        });
      }
    },

    onReconnect() {
      // Continuity is broken: accumulating hold-windows reset AND rolling
      // price windows are wiped (they must refill before price_move can hold).
      priceWindows.clear();
      const now = Date.now();
      for (const ar of rules.values()) applyEvent(ar, { type: "reconnect", nowMs: now });
    },

    onTickSizeChange(tokenId) {
      const set = tokenSubs.get(tokenId);
      if (!set) return;
      const now = Date.now();
      for (const id of [...set]) {
        const ar = rules.get(id);
        if (ar) applyEvent(ar, { type: "tick_size_change", nowMs: now });
      }
    },

    stop() {
      clearInterval(reloadTimer);
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    },
  };
};
