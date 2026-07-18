import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { strategyDrafts, type StrategyDraftRow } from "./schema.js";

export interface UpsertDraftInput {
  walletAddress: string;
  clientDraftId: string;
  name: string;
  origin: string;
  doc: unknown;
  aiMessages: unknown;
  aiHistory: unknown;
  tags: readonly string[];
  schemaVersion: number;
  /** Client-side updatedAt (ms) — the last-write-wins clock. */
  updatedAtClient: number;
  status?: "active" | "archived" | "consumed";
  armedRuleId?: string | null;
}

export interface DraftStore {
  /**
   * Insert-or-update with last-write-wins on updatedAtClient: a stale push
   * (older than the stored row) is ignored and the stored row returned.
   */
  upsert(input: UpsertDraftInput): Promise<StrategyDraftRow>;
  listActive(walletAddress: string, limit?: number): Promise<StrategyDraftRow[]>;
  find(walletAddress: string, clientDraftId: string): Promise<StrategyDraftRow | null>;
  archive(walletAddress: string, clientDraftId: string): Promise<StrategyDraftRow | null>;
}

export const createDraftStore = (db: Database): DraftStore => {
  const find = async (
    walletAddress: string,
    clientDraftId: string,
  ): Promise<StrategyDraftRow | null> => {
    const [row] = await db
      .select()
      .from(strategyDrafts)
      .where(
        and(
          eq(strategyDrafts.walletAddress, walletAddress),
          eq(strategyDrafts.clientDraftId, clientDraftId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  return {
  async upsert(input) {
    const existing = await find(input.walletAddress, input.clientDraftId);
    if (existing && existing.updatedAtClient > input.updatedAtClient) return existing;
    const values = {
      walletAddress: input.walletAddress,
      clientDraftId: input.clientDraftId,
      name: input.name,
      origin: input.origin,
      doc: input.doc,
      aiMessages: input.aiMessages,
      aiHistory: input.aiHistory,
      tags: [...input.tags],
      schemaVersion: input.schemaVersion,
      updatedAtClient: input.updatedAtClient,
      ...(input.status ? { status: input.status } : {}),
      ...(input.armedRuleId !== undefined ? { armedRuleId: input.armedRuleId } : {}),
    };
    const [row] = await db
      .insert(strategyDrafts)
      .values(values)
      .onConflictDoUpdate({
        target: [strategyDrafts.walletAddress, strategyDrafts.clientDraftId],
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert strategy draft");
    return row;
  },

  async listActive(walletAddress, limit = 50) {
    return db
      .select()
      .from(strategyDrafts)
      .where(
        and(eq(strategyDrafts.walletAddress, walletAddress), eq(strategyDrafts.status, "active")),
      )
      .orderBy(desc(strategyDrafts.updatedAtClient))
      .limit(limit);
  },

  find,

  async archive(walletAddress, clientDraftId) {
    const [row] = await db
      .update(strategyDrafts)
      .set({ status: "archived", updatedAt: sql`now()` })
      .where(
        and(
          eq(strategyDrafts.walletAddress, walletAddress),
          eq(strategyDrafts.clientDraftId, clientDraftId),
        ),
      )
      .returning();
    return row ?? null;
  },
  };
};
