import { and, eq, inArray, sql } from "drizzle-orm";
import type { ReasonCode, RuleStatus, TriggerEvidence, TriggerEvidenceV2 } from "@mx2/rules";
import type { Database } from "./client.js";
import {
  conditionalRules,
  notificationOutbox,
  ruleTriggers,
  type ConditionalRuleRow,
  type RuleTriggerRow,
} from "./schema.js";
import {
  evaluationUpdateSet,
  EVALUABLE_STATUSES,
  type RuleEvaluationUpdate,
  type TriggerStatus,
} from "./conditional-store.js";

/**
 * Atomic trigger commit — the money-path write of the conditional engine.
 *
 * The legacy sequence (CAS status update → separate trigger insert → separate
 * outbox insert) had four failure modes, all observed or derivable in
 * production (docs/TRIGGER_RELIABILITY_AUDIT.md):
 *   - the CAS succeeded but the trigger insert failed → a rule stuck
 *     TRIGGERED_AWAITING_USER forever with NOTHING to sign;
 *   - the trigger row landed but the outbox insert failed → no notification;
 *   - overlapping evaluations could write duplicate signing prompts (the only
 *     guard was app-level and covered once-recurrence only);
 *   - a CAS loss silently discarded a computed trigger with no audit trail.
 *
 * This helper runs everything in ONE transaction:
 *   1. CAS the rule's evaluation state (guarded on evaluable statuses — a
 *      concurrent user pause/cancel wins, reported as "cas_lost");
 *   2. insert the rule_triggers row with ON CONFLICT DO NOTHING — the partial
 *      unique index on (rule_id, evidence triggerNumber) makes duplicates a
 *      no-op, reported as "duplicate" (state update stays committed);
 *   3. insert the notification outbox row (dedupe-keyed on the trigger id);
 *   4. pg_notify the event bus — delivered ONLY on commit, so a listener can
 *      never observe a trigger that was rolled back.
 *
 * Audit events deliberately stay OUTSIDE the transaction: an audit-store
 * hiccup must never roll back a signing proposal.
 */
export interface TriggerCommitOpts {
  ruleId: string;
  /** The rule's post-trigger evaluation state (CAS payload). */
  stateUpdate: RuleEvaluationUpdate;
  trigger: {
    walletAddress: string;
    evidence: TriggerEvidence | TriggerEvidenceV2;
    reasonCodes: readonly ReasonCode[];
    status: TriggerStatus;
  };
  /** Outbox row builder (dedupe key derives from the inserted trigger id). */
  outboxItem?:
    | ((triggerId: string) => {
        walletAddress: string;
        kind: string;
        dedupeKey: string;
        payload: Record<string, unknown>;
      })
    | null;
  /** Event-bus payload sent via pg_notify('mx2_events', …) on commit. */
  notify?: ((triggerId: string) => Record<string, unknown>) | null;
}

export type TriggerCommitResult =
  /** Everything landed; the trigger row is the signing proposal. */
  | { outcome: "committed"; rule: ConditionalRuleRow; trigger: RuleTriggerRow }
  /** The rule left the evaluable statuses concurrently (user pause/cancel wins). */
  | { outcome: "cas_lost" }
  /** This triggerNumber already has a row — state committed, nothing new to sign. */
  | { outcome: "duplicate"; rule: ConditionalRuleRow };

export type CommitTrigger = (opts: TriggerCommitOpts) => Promise<TriggerCommitResult>;

/** The pg NOTIFY channel every mx2 realtime consumer LISTENs on. */
export const EVENT_BUS_CHANNEL = "mx2_events";

export const commitTriggerAtomically = async (
  db: Database,
  opts: TriggerCommitOpts,
): Promise<TriggerCommitResult> =>
  db.transaction(async (tx) => {
    const [rule] = await tx
      .update(conditionalRules)
      .set(evaluationUpdateSet(opts.stateUpdate))
      .where(
        and(
          eq(conditionalRules.id, opts.ruleId),
          inArray(conditionalRules.status, EVALUABLE_STATUSES as RuleStatus[]),
        ),
      )
      .returning();
    if (!rule) return { outcome: "cas_lost" } as const;

    const [trigger] = await tx
      .insert(ruleTriggers)
      .values({
        ruleId: opts.ruleId,
        walletAddress: opts.trigger.walletAddress,
        evidence: opts.trigger.evidence,
        reasonCodes: [...opts.trigger.reasonCodes],
        status: opts.trigger.status,
      })
      .onConflictDoNothing()
      .returning();
    if (!trigger) return { outcome: "duplicate", rule } as const;

    if (opts.outboxItem) {
      const item = opts.outboxItem(trigger.id);
      await tx
        .insert(notificationOutbox)
        .values({
          walletAddress: item.walletAddress,
          kind: item.kind,
          dedupeKey: item.dedupeKey,
          payload: item.payload,
        })
        .onConflictDoNothing({ target: notificationOutbox.dedupeKey });
    }

    if (opts.notify) {
      const payload = JSON.stringify(opts.notify(trigger.id));
      await tx.execute(sql`select pg_notify(${EVENT_BUS_CHANNEL}, ${payload})`);
    }

    return { outcome: "committed", rule, trigger } as const;
  });
