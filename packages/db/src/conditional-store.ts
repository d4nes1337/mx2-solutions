import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type {
  ReasonCode,
  RuleDefinition,
  RuleStatus,
  StrategyDefinition,
  TriggerEvidence,
  TriggerEvidenceV2,
} from "@mx2/rules";
import type { Database } from "./client.js";
import {
  conditionalRules,
  ruleTriggers,
  type ConditionalRuleRow,
  type RuleTriggerRow,
} from "./schema.js";

/** Statuses the worker may transition. PAUSED and all terminals are excluded. */
const EVALUABLE: readonly RuleStatus[] = ["ACTIVE_WAITING", "ACTIVE_ACCUMULATING"];

/**
 * Terminal statuses — the only ones that may be archived. An active or paused
 * strategy can never be hidden from monitoring.
 */
const ARCHIVABLE: readonly RuleStatus[] = [
  "CANCELLED",
  "COMPLETED",
  "EXECUTED_MANUALLY",
  "EXECUTED_AUTO",
  "EXECUTION_FAILED",
  "EXPIRED",
  "INVALIDATED",
  "ERROR",
];

export type TriggerStatus =
  | "awaiting_user"
  | "confirmed"
  | "dismissed"
  | "expired"
  /** v2 alert-only triggers: delivered as a notification, nothing to confirm. */
  | "notified";

// ── Conditional rule store ────────────────────────────────────────────────────

export interface CreateRuleOpts {
  walletAddress: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  definition: RuleDefinition | StrategyDefinition;
  definitionHash: string;
  expiresAt: Date | null;
  // v2 (Smart Order DSL) fields — omitted for legacy v1 creation:
  version?: number;
  name?: string | null;
  templateId?: string | null;
  /** Every tokenId the strategy reads — the worker's subscription set. */
  tokenIds?: readonly string[];
}

export interface RuleEvaluationUpdate {
  status: RuleStatus;
  trueSinceMs: number | null;
  lastEvaluatedAt: Date;
  errorMessage?: string | null;
  /** v2 repeat bookkeeping; omitted by the legacy v1 evaluator path. */
  triggerCount?: number;
  cooldownUntilMs?: number | null;
  /**
   * Trailing watermarks (migration 0011). Omitted = leave the column
   * untouched; the worker only writes when a watermark actually moved.
   */
  watermarks?: Record<string, unknown> | null;
  /**
   * Stale-pause marker (migration 0019): ms timestamp when the hold window
   * paused on stale data; null = not paused. Omitted = leave untouched
   * (legacy v1 evaluator path).
   */
  staleSinceMs?: number | null;
}

export interface RuleStore {
  create(opts: CreateRuleOpts): Promise<ConditionalRuleRow>;
  findById(id: string): Promise<ConditionalRuleRow | null>;
  findByIdForWallet(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  listByWallet(
    walletAddress: string,
    limit?: number,
    opts?: { includeArchived?: boolean },
  ): Promise<ConditionalRuleRow[]>;
  /** Replace the strategy's freeform tags (validated/normalized by the route). */
  setTags(
    id: string,
    walletAddress: string,
    tags: readonly string[],
  ): Promise<ConditionalRuleRow | null>;
  /** Soft-hide a TERMINAL strategy (null when not terminal / already archived). */
  archive(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  unarchive(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  /** Rules the worker should evaluate (status ACTIVE_WAITING | ACTIVE_ACCUMULATING). */
  listEvaluable(): Promise<ConditionalRuleRow[]>;
  /**
   * Compare-and-set evaluation state: only applies if the rule is still in an
   * ACTIVE_* status. Returns the updated row, or null if the rule was
   * concurrently controlled (paused/cancelled) — the worker then drops it.
   */
  updateEvaluationState(
    id: string,
    update: RuleEvaluationUpdate,
  ): Promise<ConditionalRuleRow | null>;
  pause(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  resume(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  cancel(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  /** Move a triggered rule to EXECUTED_MANUALLY after the user confirms+submits. */
  markExecuted(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  /**
   * Auto-execution lifecycle (worker single-writer). Compare-and-set guards each
   * transition so a concurrent manual confirm/cancel wins (returns null on loss).
   */
  markExecuting(id: string): Promise<ConditionalRuleRow | null>;
  markAutoExecuted(id: string): Promise<ConditionalRuleRow | null>;
  markExecutionFailed(id: string, errorMessage: string): Promise<ConditionalRuleRow | null>;
  /** Accumulate lifetime auto-executed notional (checked against maxTotalNotional). */
  addExecutedNotional(id: string, amountUsd: number): Promise<void>;
  /** Rules stuck in EXECUTING since before `cutoff` — crash-recovery sweep input. */
  listStuckExecuting(cutoff: Date): Promise<ConditionalRuleRow[]>;
  /**
   * Crash recovery: CAS a rule back from EXECUTING to TRIGGERED_AWAITING_USER,
   * only when the crash provably happened before any order intent was created
   * (the sweep checks the intent ledger first).
   */
  revertExecuting(id: string): Promise<ConditionalRuleRow | null>;
  /**
   * Versioned edit (D-020 — definitions stay immutable): atomically create the
   * replacement rule, cancel the old one, link both directions, and carry the
   * lifetime spend accounting forward so editing can never reset caps. Returns
   * null (nothing written) when the old rule isn't the wallet's, isn't in an
   * editable status (ACTIVE_* or PAUSED), or was already superseded.
   */
  createSuperseding(
    opts: CreateRuleOpts,
    oldId: string,
  ): Promise<{ created: ConditionalRuleRow; retired: ConditionalRuleRow } | null>;
}

const tsOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

export const createRuleStore = (db: Database): RuleStore => ({
  async create(opts) {
    const [row] = await db
      .insert(conditionalRules)
      .values({
        walletAddress: opts.walletAddress,
        conditionId: opts.conditionId,
        tokenId: opts.tokenId,
        side: opts.side,
        definition: opts.definition,
        definitionHash: opts.definitionHash,
        status: "ACTIVE_WAITING",
        expiresAt: opts.expiresAt,
        version: opts.version ?? 1,
        name: opts.name ?? null,
        templateId: opts.templateId ?? null,
        tokenIds: [...(opts.tokenIds ?? [opts.tokenId])],
      })
      .returning();
    if (!row) throw new Error("Failed to create conditional rule");
    return row;
  },

  async findById(id) {
    const [row] = await db
      .select()
      .from(conditionalRules)
      .where(eq(conditionalRules.id, id))
      .limit(1);
    return row ?? null;
  },

  async findByIdForWallet(id, walletAddress) {
    const [row] = await db
      .select()
      .from(conditionalRules)
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.walletAddress, walletAddress)))
      .limit(1);
    return row ?? null;
  },

  async listByWallet(walletAddress, limit = 100, opts) {
    return db
      .select()
      .from(conditionalRules)
      .where(
        and(
          eq(conditionalRules.walletAddress, walletAddress),
          ...(opts?.includeArchived ? [] : [isNull(conditionalRules.archivedAt)]),
        ),
      )
      .orderBy(desc(conditionalRules.createdAt))
      .limit(limit);
  },

  async setTags(id, walletAddress, tags) {
    const [row] = await db
      .update(conditionalRules)
      .set({ tags: [...tags], updatedAt: sql`now()` })
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.walletAddress, walletAddress)))
      .returning();
    return row ?? null;
  },

  async archive(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(conditionalRules.id, id),
          eq(conditionalRules.walletAddress, walletAddress),
          inArray(conditionalRules.status, ARCHIVABLE as RuleStatus[]),
          isNull(conditionalRules.archivedAt),
        ),
      )
      .returning();
    return row ?? null;
  },

  async unarchive(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({ archivedAt: null, updatedAt: sql`now()` })
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.walletAddress, walletAddress)))
      .returning();
    return row ?? null;
  },

  async listEvaluable() {
    return db
      .select()
      .from(conditionalRules)
      .where(inArray(conditionalRules.status, EVALUABLE as RuleStatus[]));
  },

  async updateEvaluationState(id, update) {
    const [row] = await db
      .update(conditionalRules)
      .set({
        status: update.status,
        trueSince: tsOrNull(update.trueSinceMs),
        lastEvaluatedAt: update.lastEvaluatedAt,
        errorMessage: update.errorMessage ?? null,
        ...(update.triggerCount !== undefined ? { triggerCount: update.triggerCount } : {}),
        ...(update.cooldownUntilMs !== undefined
          ? { cooldownUntil: tsOrNull(update.cooldownUntilMs) }
          : {}),
        ...(update.watermarks !== undefined ? { runtimeWatermarks: update.watermarks } : {}),
        ...(update.staleSinceMs !== undefined ? { staleSince: tsOrNull(update.staleSinceMs) } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(conditionalRules.id, id),
          inArray(conditionalRules.status, EVALUABLE as RuleStatus[]),
        ),
      )
      .returning();
    return row ?? null;
  },

  async pause(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({
        status: "PAUSED",
        pausedAt: sql`now()`,
        trueSince: null,
        staleSince: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(conditionalRules.id, id),
          eq(conditionalRules.walletAddress, walletAddress),
          inArray(conditionalRules.status, EVALUABLE as RuleStatus[]),
        ),
      )
      .returning();
    return row ?? null;
  },

  async resume(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({
        status: "ACTIVE_WAITING",
        pausedAt: null,
        trueSince: null,
        staleSince: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(conditionalRules.id, id),
          eq(conditionalRules.walletAddress, walletAddress),
          eq(conditionalRules.status, "PAUSED"),
        ),
      )
      .returning();
    return row ?? null;
  },

  async cancel(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "CANCELLED", updatedAt: sql`now()` })
      .where(
        and(
          eq(conditionalRules.id, id),
          eq(conditionalRules.walletAddress, walletAddress),
          inArray(conditionalRules.status, [...EVALUABLE, "PAUSED"] as RuleStatus[]),
        ),
      )
      .returning();
    return row ?? null;
  },

  async markExecuted(id, walletAddress) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "EXECUTED_MANUALLY", updatedAt: sql`now()` })
      .where(
        and(
          eq(conditionalRules.id, id),
          eq(conditionalRules.walletAddress, walletAddress),
          eq(conditionalRules.status, "TRIGGERED_AWAITING_USER"),
        ),
      )
      .returning();
    return row ?? null;
  },

  async markExecuting(id) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "EXECUTING", updatedAt: sql`now()` })
      .where(
        and(eq(conditionalRules.id, id), eq(conditionalRules.status, "TRIGGERED_AWAITING_USER")),
      )
      .returning();
    return row ?? null;
  },

  async markAutoExecuted(id) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "EXECUTED_AUTO", updatedAt: sql`now()` })
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.status, "EXECUTING")))
      .returning();
    return row ?? null;
  },

  async markExecutionFailed(id, errorMessage) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "EXECUTION_FAILED", errorMessage, updatedAt: sql`now()` })
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.status, "EXECUTING")))
      .returning();
    return row ?? null;
  },

  async addExecutedNotional(id, amountUsd) {
    await db
      .update(conditionalRules)
      .set({
        totalNotionalExecuted: sql`${conditionalRules.totalNotionalExecuted} + ${amountUsd}`,
        updatedAt: sql`now()`,
      })
      .where(eq(conditionalRules.id, id));
  },

  async listStuckExecuting(cutoff) {
    return db
      .select()
      .from(conditionalRules)
      .where(and(eq(conditionalRules.status, "EXECUTING"), lt(conditionalRules.updatedAt, cutoff)));
  },

  async revertExecuting(id) {
    const [row] = await db
      .update(conditionalRules)
      .set({ status: "TRIGGERED_AWAITING_USER", updatedAt: sql`now()` })
      .where(and(eq(conditionalRules.id, id), eq(conditionalRules.status, "EXECUTING")))
      .returning();
    return row ?? null;
  },

  async createSuperseding(opts, oldId) {
    return db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(conditionalRules)
        .where(
          and(
            eq(conditionalRules.id, oldId),
            eq(conditionalRules.walletAddress, opts.walletAddress),
            inArray(conditionalRules.status, [...EVALUABLE, "PAUSED"] as RuleStatus[]),
            isNull(conditionalRules.supersededBy),
          ),
        )
        .limit(1)
        .for("update");
      if (!old) return null;
      const [created] = await tx
        .insert(conditionalRules)
        .values({
          walletAddress: opts.walletAddress,
          conditionId: opts.conditionId,
          tokenId: opts.tokenId,
          side: opts.side,
          definition: opts.definition,
          definitionHash: opts.definitionHash,
          status: "ACTIVE_WAITING",
          expiresAt: opts.expiresAt,
          version: opts.version ?? 1,
          name: opts.name ?? null,
          templateId: opts.templateId ?? null,
          tokenIds: [...(opts.tokenIds ?? [opts.tokenId])],
          supersedes: oldId,
          totalNotionalExecuted: old.totalNotionalExecuted,
          tags: old.tags,
        })
        .returning();
      if (!created) throw new Error("Failed to create superseding rule");
      const [retired] = await tx
        .update(conditionalRules)
        .set({
          status: "CANCELLED",
          supersededBy: created.id,
          trueSince: null,
          staleSince: null,
          updatedAt: sql`now()`,
        })
        .where(eq(conditionalRules.id, oldId))
        .returning();
      if (!retired) throw new Error("Failed to retire superseded rule");
      return { created, retired };
    });
  },
});

// ── Rule trigger store ────────────────────────────────────────────────────────

export interface CreateTriggerOpts {
  ruleId: string;
  walletAddress: string;
  evidence: TriggerEvidence | TriggerEvidenceV2;
  reasonCodes: readonly ReasonCode[];
  /** Defaults to "awaiting_user" (order actions); alerts pass "notified". */
  status?: TriggerStatus;
}

export interface TriggerStore {
  create(opts: CreateTriggerOpts): Promise<RuleTriggerRow>;
  findById(id: string): Promise<RuleTriggerRow | null>;
  findByIdForWallet(id: string, walletAddress: string): Promise<RuleTriggerRow | null>;
  listByWallet(walletAddress: string, limit?: number): Promise<RuleTriggerRow[]>;
  listAwaiting(walletAddress: string): Promise<RuleTriggerRow[]>;
  /** All triggers for one rule, newest first — the strategy timeline. */
  listByRule(ruleId: string, limit?: number): Promise<RuleTriggerRow[]>;
  /** Defensive idempotency: at most one trigger per rule for recurrence "once". */
  hasForRule(ruleId: string): Promise<boolean>;
  updateStatus(id: string, status: TriggerStatus, opts?: { orderIntentId?: string }): Promise<void>;
  /**
   * Schedule a bounded auto-retry (migration 0019): the auto-executor skipped
   * this trigger for a recoverable reason (funds in transit, allowances
   * pending); the sweeper may re-attempt until `until`.
   */
  scheduleAutoRetry(id: string, until: Date, reason: string): Promise<void>;
  /** Clear a scheduled retry (executed, abandoned, or the user acted first). */
  clearAutoRetry(id: string): Promise<void>;
  /** Triggers still awaiting the user whose retry deadline is in the future. */
  listAutoRetryable(now: Date, limit?: number): Promise<RuleTriggerRow[]>;
  /** Triggers whose retry deadline lapsed without executing (cleanup + notify). */
  listAutoRetryLapsed(now: Date, limit?: number): Promise<RuleTriggerRow[]>;
}

export const createTriggerStore = (db: Database): TriggerStore => ({
  async create(opts) {
    const [row] = await db
      .insert(ruleTriggers)
      .values({
        ruleId: opts.ruleId,
        walletAddress: opts.walletAddress,
        evidence: opts.evidence,
        reasonCodes: [...opts.reasonCodes],
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      })
      .returning();
    if (!row) throw new Error("Failed to create rule trigger");
    return row;
  },

  async findById(id) {
    const [row] = await db.select().from(ruleTriggers).where(eq(ruleTriggers.id, id)).limit(1);
    return row ?? null;
  },

  async findByIdForWallet(id, walletAddress) {
    const [row] = await db
      .select()
      .from(ruleTriggers)
      .where(and(eq(ruleTriggers.id, id), eq(ruleTriggers.walletAddress, walletAddress)))
      .limit(1);
    return row ?? null;
  },

  async listByWallet(walletAddress, limit = 100) {
    return db
      .select()
      .from(ruleTriggers)
      .where(eq(ruleTriggers.walletAddress, walletAddress))
      .orderBy(desc(ruleTriggers.triggeredAt))
      .limit(limit);
  },

  async listAwaiting(walletAddress) {
    return db
      .select()
      .from(ruleTriggers)
      .where(
        and(
          eq(ruleTriggers.walletAddress, walletAddress),
          eq(ruleTriggers.status, "awaiting_user"),
        ),
      )
      .orderBy(desc(ruleTriggers.triggeredAt));
  },

  async listByRule(ruleId, limit = 50) {
    return db
      .select()
      .from(ruleTriggers)
      .where(eq(ruleTriggers.ruleId, ruleId))
      .orderBy(desc(ruleTriggers.triggeredAt))
      .limit(limit);
  },

  async hasForRule(ruleId) {
    const [row] = await db
      .select({ id: ruleTriggers.id })
      .from(ruleTriggers)
      .where(eq(ruleTriggers.ruleId, ruleId))
      .limit(1);
    return row !== undefined;
  },

  async updateStatus(id, status, opts) {
    await db
      .update(ruleTriggers)
      .set({
        status,
        ...(opts?.orderIntentId !== undefined ? { orderIntentId: opts.orderIntentId } : {}),
        // Any status movement invalidates a scheduled retry — the user acted,
        // or the trigger resolved some other way.
        ...(status !== "awaiting_user" ? { autoRetryUntil: null } : {}),
      })
      .where(eq(ruleTriggers.id, id));
  },

  async scheduleAutoRetry(id, until, reason) {
    // First schedule wins: later skips must not keep extending the window.
    await db
      .update(ruleTriggers)
      .set({ autoRetryUntil: until, autoRetryReason: reason })
      .where(
        and(
          eq(ruleTriggers.id, id),
          eq(ruleTriggers.status, "awaiting_user"),
          isNull(ruleTriggers.autoRetryUntil),
        ),
      );
  },

  async clearAutoRetry(id) {
    await db.update(ruleTriggers).set({ autoRetryUntil: null }).where(eq(ruleTriggers.id, id));
  },

  async listAutoRetryable(now, limit = 100) {
    return db
      .select()
      .from(ruleTriggers)
      .where(and(eq(ruleTriggers.status, "awaiting_user"), gt(ruleTriggers.autoRetryUntil, now)))
      .orderBy(desc(ruleTriggers.triggeredAt))
      .limit(limit);
  },

  async listAutoRetryLapsed(now, limit = 100) {
    return db
      .select()
      .from(ruleTriggers)
      .where(and(eq(ruleTriggers.status, "awaiting_user"), lt(ruleTriggers.autoRetryUntil, now)))
      .orderBy(desc(ruleTriggers.triggeredAt))
      .limit(limit);
  },
});
