import type { Logger } from "@mx2/observability";
import type { AuditStore, RuleStore, TriggerStore, ConditionalRuleRow } from "@mx2/db";
import {
  conditionLeaves,
  isTerminal,
  normalizeDefinition,
  referencedTokenIds,
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
  /** Price print/tick/mid — feeds rolling price_move windows. */
  onPrice(tokenId: string, price: number, tMs: number): void;
  onReconnect(): void;
  onTickSizeChange(tokenId: string): void;
  stop(): void;
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
  /** How often to reconcile the active rule set from the DB. Default 5 s. */
  reloadIntervalMs?: number;
  /** How often to tick rules for staleness / window completion. Default 1 s. */
  tickIntervalMs?: number;
}

interface ActiveRule {
  readonly id: string;
  readonly walletAddress: string;
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
  const { logger, ruleStore, triggerStore, auditStore, subscribe, unsubscribe, autoExecutor } =
    opts;
  const reloadIntervalMs = opts.reloadIntervalMs ?? 5_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 1_000;

  const rules = new Map<string, ActiveRule>();
  const tokenSubs = new Map<string, Set<string>>();
  const latestView = new Map<string, MarketDataView>();
  const priceWindows = createPriceWindowStore();
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

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
    // Conservative restart: never resume mid-accumulation across a reload/restart
    // (app-restart-mid-window robustness is deferred) — but PRESERVE the repeat
    // bookkeeping (triggerCount, cooldownUntil) AND the trailing watermarks
    // (D-025: a trailing stop keeps protecting through a restart; resetting
    // the peak on every restart would walk the stop level down a decline).
    const runtime: StrategyRuntime = {
      status: "ACTIVE_WAITING",
      trueSinceMs: null,
      lastEventTimeMs: null,
      triggerCount: row.triggerCount ?? 0,
      cooldownUntilMs: row.cooldownUntil ? row.cooldownUntil.getTime() : null,
      watermarks: (row.runtimeWatermarks as WatermarksByNode | null) ?? {},
    };
    rules.set(row.id, {
      id: row.id,
      walletAddress: row.walletAddress,
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

    // Audit only meaningful (terminal) transitions to keep the log signal-rich.
    if (
      result.transition &&
      result.transition.to !== "TRIGGERED_AWAITING_USER" &&
      isTerminal(result.transition.to)
    ) {
      await auditStore.emit({
        actor: ar.walletAddress,
        action: "rule.state_changed",
        subject: `rule:${ar.id}`,
        metadata: {
          from: result.transition.from,
          to: result.transition.to,
          reason: result.transition.reason,
        },
      });
    }

    if (isTerminal(result.runtime.status)) removeRule(ar.id);
  };

  const applyEvent = (ar: ActiveRule, event: EvalEventV2): void => {
    const result = transitionV2(ar.def, ar.defHash, ar.runtime, event);
    const runtimeChanged =
      result.runtime.triggerCount !== ar.runtime.triggerCount ||
      result.runtime.cooldownUntilMs !== ar.runtime.cooldownUntilMs ||
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
      logger.info({ reloadIntervalMs, tickIntervalMs }, "Conditional-rule evaluator started");
    },

    onBook(view) {
      latestView.set(view.tokenId, view);
      const set = tokenSubs.get(view.tokenId);
      if (!set) return;
      const now = Date.now();
      for (const id of [...set]) {
        const ar = rules.get(id);
        if (ar) applyEvent(ar, { type: "book", views: viewsFor(ar), nowMs: now });
      }
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
    },
  };
};
