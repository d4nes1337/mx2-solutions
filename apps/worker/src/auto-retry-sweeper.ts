/**
 * Bounded funds-arrival retry (migration 0019). When the auto-executor skipped
 * a trigger for a RECOVERABLE reason (deposit still bridging, allowances not
 * yet bootstrapped), the trigger carries `autoRetryUntil`. This sweeper
 * re-attempts those triggers on a short cadence — worst-case added latency is
 * one interval after the deposit completes, which keeps the design free of
 * cross-module event wiring.
 *
 * Safety posture:
 *  - Conditions are RE-VERIFIED FRESH at retry time (stateless evaluation over
 *    just-fetched books, zero stale tolerance). The trigger already earned its
 *    hold window; this gate only proves the market hasn't moved away.
 *  - Execution goes through the full auto-executor guard chain with the SAME
 *    triggerId — the deterministic idempotency key `auto:<ruleId>:<triggerId>`
 *    makes double-submission impossible.
 *  - The user always wins: any trigger status movement clears the schedule.
 *  - price_move conditions cannot be re-verified statelessly (no rolling
 *    window here) — those retries abandon to manual rather than guess.
 */
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  ConditionalRuleRow,
  NotificationOutboxStore,
  RuleStore,
  RuleTriggerRow,
  TriggerStore,
} from "@mx2/db";
import {
  conditionLeaves,
  evaluateExpression,
  normalizeDefinition,
  referencedTokenIds,
  type MarketDataView,
  type RuleDefinition,
  type StrategyDefinition,
  type TriggerEvidence,
  type TriggerEvidenceV2,
  type ViewsByToken,
  type WatermarksByNode,
} from "@mx2/rules";
import type { AutoExecutor } from "./auto-executor.js";

export interface AutoRetrySweeperDeps {
  logger: Logger;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  auditStore: AuditStore;
  autoExecutor: AutoExecutor;
  /** Fresh orderbook fetch (same lambda the evaluator's REST verify uses). */
  fetchOrderbook: (tokenId: string) => Promise<MarketDataView | null>;
  outbox?: NotificationOutboxStore;
  intervalMs?: number;
}

export interface AutoRetrySweeper {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
}

/** Rule statuses a retry may act on (user pause/cancel always wins). */
const RETRYABLE_RULE_STATUSES = new Set([
  "TRIGGERED_AWAITING_USER",
  "ACTIVE_WAITING",
  "ACTIVE_ACCUMULATING",
]);

export const createAutoRetrySweeper = (deps: AutoRetrySweeperDeps): AutoRetrySweeper => {
  const intervalMs = deps.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const abandon = async (
    trigger: RuleTriggerRow,
    rule: ConditionalRuleRow | null,
    reason: string,
  ): Promise<void> => {
    await deps.triggerStore.clearAutoRetry(trigger.id);
    await deps.auditStore.emit({
      actor: trigger.walletAddress,
      action: "rule.execution.retry_abandoned",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId: trigger.id, reason },
    });
    if (deps.outbox && rule) {
      await deps.outbox
        .enqueue({
          walletAddress: trigger.walletAddress,
          kind: "auto_retry_abandoned",
          dedupeKey: `retry-abandoned:${trigger.id}`,
          payload: {
            ruleId: trigger.ruleId,
            name: rule.name ?? null,
            triggerId: trigger.id,
            reason,
          },
        })
        .catch((e: unknown) =>
          deps.logger.warn({ err: e, triggerId: trigger.id }, "Retry-abandon notify failed"),
        );
    }
  };

  const retryOne = async (trigger: RuleTriggerRow): Promise<void> => {
    const rule = await deps.ruleStore.findById(trigger.ruleId);
    if (!rule || !RETRYABLE_RULE_STATUSES.has(rule.status)) {
      await abandon(trigger, rule, "rule_inactive");
      return;
    }
    let def: StrategyDefinition;
    try {
      def = normalizeDefinition(rule.definition as RuleDefinition | StrategyDefinition);
    } catch {
      await abandon(trigger, rule, "definition_unparseable");
      return;
    }
    if (conditionLeaves(def.expr).some((l) => l.condition.kind === "price_move")) {
      await abandon(trigger, rule, "price_move_not_reverifiable");
      return;
    }

    // Fresh stateless re-verification: every referenced book fetched NOW.
    const nowMs = Date.now();
    const views: Record<string, MarketDataView> = {};
    for (const tokenId of referencedTokenIds(def)) {
      const view = await deps.fetchOrderbook(tokenId);
      if (!view) {
        // Can't verify → don't execute, don't abandon; try again next pass.
        deps.logger.warn({ triggerId: trigger.id, tokenId }, "Retry re-verify fetch failed");
        return;
      }
      views[tokenId] = view;
    }
    const evalResult = evaluateExpression(
      def,
      views as ViewsByToken,
      nowMs,
      (rule.runtimeWatermarks as WatermarksByNode | null) ?? {},
    );
    if (!evalResult.satisfied || evalResult.staleTokenIds.length > 0) {
      await abandon(trigger, rule, "conditions_no_longer_met");
      return;
    }

    await deps.auditStore.emit({
      actor: trigger.walletAddress,
      action: "rule.execution.retried",
      subject: `rule:${trigger.ruleId}`,
      metadata: { triggerId: trigger.id, blockedReason: trigger.autoRetryReason },
    });
    await deps.autoExecutor.execute({
      rule: {
        id: rule.id,
        walletAddress: rule.walletAddress,
        tokenId: rule.tokenId,
        def,
      },
      triggerId: trigger.id,
      evidence: trigger.evidence as TriggerEvidence | TriggerEvidenceV2,
      nowMs,
    });
    // If the blocker is still present the executor skips again; the original
    // window (first-schedule-wins) keeps counting down toward abandonment.
  };

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      for (const lapsed of await deps.triggerStore.listAutoRetryLapsed(now)) {
        const rule = await deps.ruleStore.findById(lapsed.ruleId);
        await abandon(lapsed, rule, "retry_window_expired");
      }
      for (const trigger of await deps.triggerStore.listAutoRetryable(now)) {
        try {
          await retryOne(trigger);
        } catch (e) {
          deps.logger.warn({ err: e, triggerId: trigger.id }, "Auto-retry attempt failed");
        }
      }
    } catch (e) {
      deps.logger.warn({ err: e }, "Auto-retry sweep failed");
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void runOnce(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    runOnce,
  };
};
