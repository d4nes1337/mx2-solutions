import type { Logger } from "@mx2/observability";
import type { AuditStore, RuleStore, TriggerStore, ConditionalRuleRow } from "@mx2/db";
import {
  isTerminal,
  transition,
  type EvalEvent,
  type MarketDataView,
  type RuleDefinition,
  type RuleRuntime,
  type TransitionResult,
} from "@mx2/rules";

/**
 * Single-writer conditional-rule evaluator (L3 host). Lives in the worker so a
 * rule's deterministic state machine has exactly one writer. It:
 *   - periodically reloads the evaluable rule set from the DB,
 *   - drives WS subscriptions for the tokens those rules watch,
 *   - feeds each rule book/tick/reconnect/tick-size events, and
 *   - persists state changes + writes a rule_triggers row on a trigger.
 *
 * A trigger NEVER submits an order — it only records evidence + an audit event
 * and awaits manual confirmation (docs/04 §1, §6). DB writes use compare-and-set
 * (RuleStore.updateEvaluationState) so a concurrent user pause/cancel wins.
 *
 * Deferred seam: a single worker satisfies single-writer today (D-001). For
 * multi-instance, take a Postgres advisory lock / lease per rule before owning
 * it — see docs/adr/0005 and RISK register.
 */
export interface RuleEvaluatorManager {
  start(): void;
  onBook(view: MarketDataView): void;
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
  /** How often to reconcile the active rule set from the DB. Default 5 s. */
  reloadIntervalMs?: number;
  /** How often to tick rules for staleness / window completion. Default 1 s. */
  tickIntervalMs?: number;
}

interface ActiveRule {
  readonly id: string;
  readonly walletAddress: string;
  readonly tokenId: string;
  readonly def: RuleDefinition;
  runtime: RuleRuntime;
  /** Serializes DB writes per rule so persisted status reflects event order. */
  writeChain: Promise<void>;
}

export const createRuleEvaluatorManager = (opts: RuleEvaluatorOptions): RuleEvaluatorManager => {
  const { logger, ruleStore, triggerStore, auditStore, subscribe, unsubscribe } = opts;
  const reloadIntervalMs = opts.reloadIntervalMs ?? 5_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 1_000;

  const rules = new Map<string, ActiveRule>();
  const tokenSubs = new Map<string, Set<string>>();
  const latestView = new Map<string, MarketDataView>();
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  const addRule = (row: ConditionalRuleRow): void => {
    let def: RuleDefinition;
    try {
      def = row.definition as RuleDefinition;
    } catch (e) {
      logger.warn({ err: e, ruleId: row.id }, "Skipping rule with unparseable definition");
      return;
    }
    // Conservative restart: never resume mid-accumulation across a reload/restart
    // (app-restart-mid-window robustness is deferred). Start fresh from WAITING.
    const runtime: RuleRuntime = {
      status: "ACTIVE_WAITING",
      trueSinceMs: null,
      lastEventTimeMs: null,
    };
    rules.set(row.id, {
      id: row.id,
      walletAddress: row.walletAddress,
      tokenId: row.tokenId,
      def,
      runtime,
      writeChain: Promise.resolve(),
    });
    let set = tokenSubs.get(row.tokenId);
    if (!set) {
      set = new Set();
      tokenSubs.set(row.tokenId, set);
      subscribe([row.tokenId]);
    }
    set.add(row.id);
  };

  const removeRule = (id: string): void => {
    const ar = rules.get(id);
    if (!ar) return;
    rules.delete(id);
    const set = tokenSubs.get(ar.tokenId);
    if (set) {
      set.delete(id);
      if (set.size === 0) {
        tokenSubs.delete(ar.tokenId);
        latestView.delete(ar.tokenId);
        unsubscribe([ar.tokenId]);
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

  const persist = async (
    ar: ActiveRule,
    result: TransitionResult,
    nowMs: number,
  ): Promise<void> => {
    const updated = await ruleStore.updateEvaluationState(ar.id, {
      status: result.runtime.status,
      trueSinceMs: result.runtime.trueSinceMs,
      lastEvaluatedAt: new Date(nowMs),
    });
    if (!updated) {
      // The rule was concurrently controlled (paused/cancelled) — user wins.
      removeRule(ar.id);
      return;
    }

    if (result.trigger) {
      // Defensive single-trigger guard on top of the state machine's guarantee.
      const exists = await triggerStore.hasForRule(ar.id);
      if (!exists) {
        const trig = await triggerStore.create({
          ruleId: ar.id,
          walletAddress: ar.walletAddress,
          evidence: result.trigger,
          reasonCodes: result.trigger.reasonCodes,
        });
        await auditStore.emit({
          actor: ar.walletAddress,
          action: "rule.triggered",
          subject: `rule:${ar.id}`,
          metadata: {
            triggerId: trig.id,
            windowStartMs: result.trigger.windowStartMs,
            triggeredAtMs: result.trigger.triggeredAtMs,
            bestAsk: result.trigger.bestAsk,
            bestBid: result.trigger.bestBid,
          },
        });
        logger.info(
          { ruleId: ar.id, triggerId: trig.id },
          "Conditional rule triggered — awaiting manual confirmation (no auto-submit)",
        );
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

  const applyEvent = (ar: ActiveRule, event: EvalEvent): void => {
    const result = transition(ar.def, ar.runtime, event);
    ar.runtime = result.runtime;
    if (!result.transition && !result.trigger) return;
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
          applyEvent(ar, {
            type: "tick",
            latestView: latestView.get(ar.tokenId) ?? null,
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
        if (ar) applyEvent(ar, { type: "book", view, nowMs: now });
      }
    },

    onReconnect() {
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
