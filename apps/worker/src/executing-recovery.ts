/**
 * Crash recovery for rules stuck in EXECUTING (RFC-0002 §6). A worker crash
 * between the markExecuting claim and the terminal transition strands the rule:
 * EXECUTING is not evaluable, so nothing ever moves it again. This sweep
 * resolves each stranded rule from the order-intent ledger — the same
 * fail-closed posture as the auto-executor, never a blind resubmit:
 *
 *   no intent            → the crash provably happened before any order could
 *                          exist → CAS back to TRIGGERED_AWAITING_USER (the
 *                          manual-confirm / retry surface re-opens).
 *   intent failed        → EXECUTION_FAILED (submit failed before the crash).
 *   intent submitted+    → EXECUTED_AUTO (the order made it out; finish the
 *                          bookkeeping that the crash interrupted).
 *   intent created       → indeterminate: the submit may have registered
 *                          upstream without an ack we recorded. Fail closed →
 *                          EXECUTION_FAILED with an operator-facing message.
 */
import type { Logger } from "@mx2/observability";
import type { AuditStore, OrderIntentStore, RuleStore, TriggerStore } from "@mx2/db";

export interface ExecutingRecoveryDeps {
  logger: Logger;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  orderIntents: OrderIntentStore;
  auditStore: AuditStore;
  /** How long a rule may sit in EXECUTING before it counts as stuck. */
  stuckAfterMs?: number;
  /** Sweep cadence. */
  intervalMs?: number;
}

export interface ExecutingRecovery {
  start(): void;
  stop(): void;
  /** One sweep pass (exported for tests and the startup call). */
  runOnce(): Promise<void>;
}

export const createExecutingRecovery = (deps: ExecutingRecoveryDeps): ExecutingRecovery => {
  const stuckAfterMs = deps.stuckAfterMs ?? 5 * 60_000;
  const intervalMs = deps.intervalMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const audit = async (
    walletAddress: string,
    ruleId: string,
    outcome: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await deps.auditStore.emit({
      actor: walletAddress,
      action: "rule.execution.recovered",
      subject: `rule:${ruleId}`,
      metadata: { outcome, ...metadata },
    });
  };

  const recoverOne = async (ruleId: string, walletAddress: string): Promise<void> => {
    const [trigger] = await deps.triggerStore.listByRule(ruleId, 1);
    if (!trigger) {
      // EXECUTING without any trigger row should be impossible; revert so the
      // rule isn't stranded, and flag loudly.
      const reverted = await deps.ruleStore.revertExecuting(ruleId);
      if (reverted) await audit(walletAddress, ruleId, "reverted_no_trigger", {});
      return;
    }
    const intent = await deps.orderIntents.findByIdempotencyKey(`auto:${ruleId}:${trigger.id}`);

    if (!intent) {
      const reverted = await deps.ruleStore.revertExecuting(ruleId);
      if (reverted) {
        await audit(walletAddress, ruleId, "reverted_awaiting_user", { triggerId: trigger.id });
        deps.logger.warn(
          { ruleId, triggerId: trigger.id },
          "Recovered EXECUTING rule with no order intent — back to awaiting user",
        );
      }
      return;
    }

    if (intent.status === "failed") {
      const marked = await deps.ruleStore.markExecutionFailed(
        ruleId,
        "Recovered after crash: order submission had failed",
      );
      if (marked) {
        await audit(walletAddress, ruleId, "execution_failed", {
          triggerId: trigger.id,
          intentId: intent.id,
        });
      }
      return;
    }

    if (intent.status === "created") {
      // Indeterminate submit — the order may exist upstream. Never resubmit.
      const marked = await deps.ruleStore.markExecutionFailed(
        ruleId,
        "Recovered after crash mid-submission: verify the order on Polymarket before retrying",
      );
      if (marked) {
        await audit(walletAddress, ruleId, "execution_indeterminate", {
          triggerId: trigger.id,
          intentId: intent.id,
        });
        deps.logger.error(
          { ruleId, intentId: intent.id },
          "EXECUTING recovery found an indeterminate intent — operator reconciliation needed",
        );
      }
      return;
    }

    // submitted / acknowledged / filled / cancelled: the order made it out —
    // finish the interrupted bookkeeping. Trigger confirmation is idempotent;
    // executed-notional accounting already ran before the trigger confirm in
    // the happy path, so it is only re-run when the trigger never confirmed
    // (possible double-count in a narrow crash window — the safe direction,
    // since caps then under-allow rather than over-allow).
    if (trigger.status === "awaiting_user") {
      const notional = Number(intent.price) * Number(intent.size);
      if (Number.isFinite(notional) && notional > 0) {
        await deps.ruleStore.addExecutedNotional(ruleId, notional);
      }
      await deps.triggerStore.updateStatus(trigger.id, "confirmed", { orderIntentId: intent.id });
    }
    const marked = await deps.ruleStore.markAutoExecuted(ruleId);
    if (marked) {
      await audit(walletAddress, ruleId, "executed_auto", {
        triggerId: trigger.id,
        intentId: intent.id,
        intentStatus: intent.status,
      });
      deps.logger.info(
        { ruleId, intentId: intent.id },
        "Recovered EXECUTING rule whose order had submitted — marked EXECUTED_AUTO",
      );
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stuck = await deps.ruleStore.listStuckExecuting(new Date(Date.now() - stuckAfterMs));
      for (const rule of stuck) {
        try {
          await recoverOne(rule.id, rule.walletAddress);
        } catch (e) {
          deps.logger.warn({ err: e, ruleId: rule.id }, "EXECUTING recovery failed for rule");
        }
      }
    } catch (e) {
      deps.logger.warn({ err: e }, "EXECUTING recovery sweep failed");
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    runOnce,
  };
};
