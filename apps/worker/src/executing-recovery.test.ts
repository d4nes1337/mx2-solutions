/**
 * Decision table for the EXECUTING crash-recovery sweep: each stranded rule is
 * resolved from the order-intent ledger, never by resubmitting.
 */
import { describe, it, expect } from "vitest";
import { createLogger } from "@mx2/observability";
import type {
  AuditStore,
  ConditionalRuleRow,
  OrderIntentRow,
  OrderIntentStore,
  RuleStore,
  RuleTriggerRow,
  TriggerStore,
} from "@mx2/db";
import { createExecutingRecovery } from "./executing-recovery.js";

const logger = createLogger({ name: "recovery-test", level: "silent" });
const WALLET = "0xowner";

const stuckRule = (id = "rule-1"): ConditionalRuleRow =>
  ({
    id,
    walletAddress: WALLET,
    status: "EXECUTING",
    updatedAt: new Date(Date.now() - 10 * 60_000),
  }) as ConditionalRuleRow;

const trigger = (over: Partial<RuleTriggerRow> = {}): RuleTriggerRow =>
  ({
    id: "trig-1",
    ruleId: "rule-1",
    walletAddress: WALLET,
    status: "awaiting_user",
    evidence: {},
    ...over,
  }) as RuleTriggerRow;

interface HarnessOpts {
  trigger?: RuleTriggerRow | null;
  intent?: Partial<OrderIntentRow> | null;
}

const makeHarness = (opts: HarnessOpts) => {
  const calls: Record<string, unknown[]> = {
    revert: [],
    failed: [],
    executed: [],
    notional: [],
    triggerStatus: [],
    audits: [],
  };
  const ruleStore = {
    listStuckExecuting: async () => [stuckRule()],
    revertExecuting: async (id: string) => {
      calls.revert!.push(id);
      return stuckRule(id);
    },
    markExecutionFailed: async (id: string, msg: string) => {
      calls.failed!.push([id, msg]);
      return stuckRule(id);
    },
    markAutoExecuted: async (id: string) => {
      calls.executed!.push(id);
      return stuckRule(id);
    },
    addExecutedNotional: async (id: string, usd: number) => {
      calls.notional!.push([id, usd]);
    },
  } as unknown as RuleStore;
  const triggerStore = {
    listByRule: async () => (opts.trigger === null ? [] : [opts.trigger ?? trigger()]),
    updateStatus: async (id: string, status: string, o?: { orderIntentId?: string }) => {
      calls.triggerStatus!.push([id, status, o?.orderIntentId]);
    },
  } as unknown as TriggerStore;
  const orderIntents = {
    findByIdempotencyKey: async () =>
      opts.intent === null || opts.intent === undefined
        ? null
        : ({ id: "intent-1", price: "0.5", size: "100", ...opts.intent } as OrderIntentRow),
  } as unknown as OrderIntentStore;
  const auditStore = {
    emit: async (e: unknown) => {
      calls.audits!.push(e);
    },
  } as unknown as AuditStore;
  const recovery = createExecutingRecovery({
    logger,
    ruleStore,
    triggerStore,
    orderIntents,
    auditStore,
  });
  return { recovery, calls };
};

const outcomes = (calls: Record<string, unknown[]>): string[] =>
  (calls.audits as { metadata: { outcome: string } }[]).map((a) => a.metadata.outcome);

describe("EXECUTING crash recovery", () => {
  it("no trigger at all → reverts (impossible state, flagged)", async () => {
    const h = makeHarness({ trigger: null });
    await h.recovery.runOnce();
    expect(h.calls.revert).toEqual(["rule-1"]);
    expect(outcomes(h.calls)).toEqual(["reverted_no_trigger"]);
  });

  it("no intent → crash before order creation → back to awaiting user", async () => {
    const h = makeHarness({ intent: null });
    await h.recovery.runOnce();
    expect(h.calls.revert).toEqual(["rule-1"]);
    expect(h.calls.failed).toHaveLength(0);
    expect(outcomes(h.calls)).toEqual(["reverted_awaiting_user"]);
  });

  it("failed intent → EXECUTION_FAILED", async () => {
    const h = makeHarness({ intent: { status: "failed" } });
    await h.recovery.runOnce();
    expect(h.calls.failed).toHaveLength(1);
    expect(h.calls.revert).toHaveLength(0);
    expect(outcomes(h.calls)).toEqual(["execution_failed"]);
  });

  it("created intent (indeterminate submit) → EXECUTION_FAILED, never resubmitted", async () => {
    const h = makeHarness({ intent: { status: "created" } });
    await h.recovery.runOnce();
    expect(h.calls.failed).toHaveLength(1);
    expect(outcomes(h.calls)).toEqual(["execution_indeterminate"]);
  });

  it("submitted intent + unconfirmed trigger → finish bookkeeping → EXECUTED_AUTO", async () => {
    const h = makeHarness({ intent: { status: "submitted" } });
    await h.recovery.runOnce();
    expect(h.calls.notional).toEqual([["rule-1", 50]]);
    expect(h.calls.triggerStatus).toEqual([["trig-1", "confirmed", "intent-1"]]);
    expect(h.calls.executed).toEqual(["rule-1"]);
    expect(outcomes(h.calls)).toEqual(["executed_auto"]);
  });

  it("submitted intent + already-confirmed trigger → only the status transition", async () => {
    const h = makeHarness({
      intent: { status: "submitted" },
      trigger: trigger({ status: "confirmed" }),
    });
    await h.recovery.runOnce();
    expect(h.calls.notional).toHaveLength(0);
    expect(h.calls.triggerStatus).toHaveLength(0);
    expect(h.calls.executed).toEqual(["rule-1"]);
  });
});
