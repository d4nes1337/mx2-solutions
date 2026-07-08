import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
}

export interface RuleStore {
  create(opts: CreateRuleOpts): Promise<ConditionalRuleRow>;
  findById(id: string): Promise<ConditionalRuleRow | null>;
  findByIdForWallet(id: string, walletAddress: string): Promise<ConditionalRuleRow | null>;
  listByWallet(walletAddress: string, limit?: number): Promise<ConditionalRuleRow[]>;
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

  async listByWallet(walletAddress, limit = 100) {
    return db
      .select()
      .from(conditionalRules)
      .where(eq(conditionalRules.walletAddress, walletAddress))
      .orderBy(desc(conditionalRules.createdAt))
      .limit(limit);
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
      .set({ status: "PAUSED", pausedAt: sql`now()`, trueSince: null, updatedAt: sql`now()` })
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
      .set({ status: "ACTIVE_WAITING", pausedAt: null, trueSince: null, updatedAt: sql`now()` })
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
  /** Defensive idempotency: at most one trigger per rule for recurrence "once". */
  hasForRule(ruleId: string): Promise<boolean>;
  updateStatus(id: string, status: TriggerStatus, opts?: { orderIntentId?: string }): Promise<void>;
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
      })
      .where(eq(ruleTriggers.id, id));
  },
});
