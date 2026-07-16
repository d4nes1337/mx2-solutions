import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  quoteEvents,
  quoteSessions,
  rewardAccruals,
  type QuoteEventRow,
  type QuoteSessionRow,
} from "./schema.js";

/**
 * Persistence for maker-loop quoting sessions (RFC-0003). quote_events is
 * append-only; `recordEvent` returns false when the idempotency key already
 * exists (the replay guard the quoter's tests assert at the DB layer).
 */

export type QuoteSessionMode = "shadow" | "confirm" | "live";
export type QuoteSessionStatus = "idle" | "quoting" | "halted";

export type QuoteEventType =
  | "cycle"
  | "quote_intent"
  | "order_placed"
  | "order_cancelled"
  | "fill"
  | "batch_proposed"
  | "merge_submitted"
  | "merge_confirmed"
  | "halt"
  | "resume";

export interface QuoteSessionUpdate {
  status?: QuoteSessionStatus;
  haltedReason?: string | null;
  inventoryYes?: number;
  inventoryNo?: number;
  capitalCommittedUsd?: number;
  realizedPnlUsd?: number;
  dailyLossUsd?: number;
  rewardsAccruedUsd?: number;
  lastCycleAt?: Date;
  /** Confirm-mode batch protocol — the WORKER is the only writer of pending_*. */
  pendingBatch?: Record<string, unknown> | null;
  pendingBatchHash?: string | null;
  pendingBatchAt?: Date | null;
  /** Cleared (nulled) by the worker after execution or re-propose. */
  approvedBatchHash?: string | null;
  approvedAt?: Date | null;
  /** Fill-accounting cost pools + the UTC day the daily loss belongs to. */
  inventoryYesCostUsd?: number;
  inventoryNoCostUsd?: number;
  dailyLossDay?: string | null;
}

export interface QuoterStore {
  /** Find-or-create the session for an armed quote_loop rule. */
  ensureSession(ruleId: string, walletAddress: string): Promise<QuoteSessionRow>;
  findSessionByRuleId(ruleId: string): Promise<QuoteSessionRow | null>;
  updateSession(id: string, update: QuoteSessionUpdate): Promise<QuoteSessionRow | null>;
  /** Audited mode escalation (shadow → confirm → live); API-only. */
  setMode(id: string, mode: QuoteSessionMode): Promise<QuoteSessionRow | null>;
  /**
   * Confirm-mode approval — the ONLY session field the API writes during a
   * running session. Guarded: succeeds only while `pending_batch_hash` still
   * equals the hash being approved; returns null when the proposal moved on
   * (BATCH_STALE) so a stale approval can never land.
   */
  approveBatch(id: string, batchHash: string): Promise<QuoteSessionRow | null>;
  /** Non-halted sessions (rewards poller sweep). */
  listActiveSessions(): Promise<QuoteSessionRow[]>;
  /**
   * Append one event. Returns false (and writes nothing) when the idempotency
   * key was already used — the anti-replay invariant.
   */
  recordEvent(event: {
    sessionId: string;
    ruleId: string;
    type: QuoteEventType;
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
  listEvents(sessionId: string, afterSeqCreatedAt?: Date, limit?: number): Promise<QuoteEventRow[]>;
  upsertRewardAccrual(row: {
    walletAddress: string;
    conditionId: string;
    day: string;
    rewardsUsd: number;
    raw: Record<string, unknown>;
  }): Promise<void>;
  sumRewardAccruals(walletAddress: string, conditionId: string): Promise<number>;
}

export const createQuoterStore = (db: Database): QuoterStore => ({
  async ensureSession(ruleId, walletAddress) {
    const existing = await db
      .select()
      .from(quoteSessions)
      .where(eq(quoteSessions.ruleId, ruleId))
      .limit(1);
    if (existing[0]) return existing[0];
    const inserted = await db.insert(quoteSessions).values({ ruleId, walletAddress }).returning();
    return inserted[0]!;
  },

  async findSessionByRuleId(ruleId) {
    const rows = await db
      .select()
      .from(quoteSessions)
      .where(eq(quoteSessions.ruleId, ruleId))
      .limit(1);
    return rows[0] ?? null;
  },

  async updateSession(id, update) {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (update.status !== undefined) set["status"] = update.status;
    if (update.haltedReason !== undefined) set["haltedReason"] = update.haltedReason;
    if (update.inventoryYes !== undefined) set["inventoryYes"] = String(update.inventoryYes);
    if (update.inventoryNo !== undefined) set["inventoryNo"] = String(update.inventoryNo);
    if (update.capitalCommittedUsd !== undefined)
      set["capitalCommittedUsd"] = String(update.capitalCommittedUsd);
    if (update.realizedPnlUsd !== undefined) set["realizedPnlUsd"] = String(update.realizedPnlUsd);
    if (update.dailyLossUsd !== undefined) set["dailyLossUsd"] = String(update.dailyLossUsd);
    if (update.rewardsAccruedUsd !== undefined)
      set["rewardsAccruedUsd"] = String(update.rewardsAccruedUsd);
    if (update.lastCycleAt !== undefined) set["lastCycleAt"] = update.lastCycleAt;
    if (update.pendingBatch !== undefined) set["pendingBatch"] = update.pendingBatch;
    if (update.pendingBatchHash !== undefined) set["pendingBatchHash"] = update.pendingBatchHash;
    if (update.pendingBatchAt !== undefined) set["pendingBatchAt"] = update.pendingBatchAt;
    if (update.approvedBatchHash !== undefined) set["approvedBatchHash"] = update.approvedBatchHash;
    if (update.approvedAt !== undefined) set["approvedAt"] = update.approvedAt;
    if (update.inventoryYesCostUsd !== undefined)
      set["inventoryYesCostUsd"] = String(update.inventoryYesCostUsd);
    if (update.inventoryNoCostUsd !== undefined)
      set["inventoryNoCostUsd"] = String(update.inventoryNoCostUsd);
    if (update.dailyLossDay !== undefined) set["dailyLossDay"] = update.dailyLossDay;
    const rows = await db
      .update(quoteSessions)
      .set(set)
      .where(eq(quoteSessions.id, id))
      .returning();
    return rows[0] ?? null;
  },

  async setMode(id, mode) {
    const rows = await db
      .update(quoteSessions)
      .set({ mode, updatedAt: new Date() })
      .where(eq(quoteSessions.id, id))
      .returning();
    return rows[0] ?? null;
  },

  async approveBatch(id, batchHash) {
    const rows = await db
      .update(quoteSessions)
      .set({ approvedBatchHash: batchHash, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(quoteSessions.id, id), eq(quoteSessions.pendingBatchHash, batchHash)))
      .returning();
    return rows[0] ?? null;
  },

  async listActiveSessions() {
    return db.select().from(quoteSessions).where(ne(quoteSessions.status, "halted"));
  },

  async recordEvent(event) {
    const rows = await db
      .insert(quoteEvents)
      .values({
        sessionId: event.sessionId,
        ruleId: event.ruleId,
        type: event.type,
        idempotencyKey: event.idempotencyKey ?? null,
        payload: event.payload,
      })
      .onConflictDoNothing({ target: quoteEvents.idempotencyKey })
      .returning({ id: quoteEvents.id });
    return rows.length > 0;
  },

  async listEvents(sessionId, after, limit = 100) {
    const where = after
      ? and(eq(quoteEvents.sessionId, sessionId), gt(quoteEvents.createdAt, after))
      : eq(quoteEvents.sessionId, sessionId);
    return db
      .select()
      .from(quoteEvents)
      .where(where)
      .orderBy(desc(quoteEvents.createdAt))
      .limit(Math.min(limit, 500));
  },

  async upsertRewardAccrual(row) {
    await db
      .insert(rewardAccruals)
      .values({
        walletAddress: row.walletAddress,
        conditionId: row.conditionId,
        day: row.day,
        rewardsUsd: String(row.rewardsUsd),
        raw: row.raw,
      })
      .onConflictDoUpdate({
        target: [rewardAccruals.walletAddress, rewardAccruals.conditionId, rewardAccruals.day],
        set: { rewardsUsd: String(row.rewardsUsd), raw: row.raw },
      });
  },

  async sumRewardAccruals(walletAddress, conditionId) {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${rewardAccruals.rewardsUsd}), 0)` })
      .from(rewardAccruals)
      .where(
        and(
          eq(rewardAccruals.walletAddress, walletAddress),
          eq(rewardAccruals.conditionId, conditionId),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  },
});
