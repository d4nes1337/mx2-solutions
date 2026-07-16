/**
 * Owner-only trading-wallet withdrawals (migration 0012). The route resolves
 * the destination from the session — this store just persists the ledger with
 * idempotency: `create` returns null when the (wallet, key) pair was already
 * used, so a double-submit can never reach the relayer twice.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { walletWithdrawals, type WalletWithdrawalRow } from "./schema.js";

export type WithdrawalState = "requested" | "submitted" | "confirmed" | "failed";

export interface CreateWithdrawalOpts {
  walletAddress: string;
  depositWalletAddress: string;
  destinationAddress: string;
  amountUsd: number;
  idempotencyKey: string;
}

export interface WithdrawalUpdate {
  state: WithdrawalState;
  relayerTransactionId?: string;
  transactionHash?: string;
  error?: string | null;
}

export interface WithdrawalStore {
  /** Insert-or-null: null = the idempotency key was already used. */
  create(opts: CreateWithdrawalOpts): Promise<WalletWithdrawalRow | null>;
  updateState(id: string, update: WithdrawalUpdate): Promise<void>;
  findByIdempotencyKey(walletAddress: string, key: string): Promise<WalletWithdrawalRow | null>;
  listByWallet(walletAddress: string, limit?: number): Promise<WalletWithdrawalRow[]>;
}

export const createWithdrawalStore = (db: Database): WithdrawalStore => ({
  async create(opts) {
    const [row] = await db
      .insert(walletWithdrawals)
      .values({
        walletAddress: opts.walletAddress.toLowerCase(),
        depositWalletAddress: opts.depositWalletAddress.toLowerCase(),
        destinationAddress: opts.destinationAddress.toLowerCase(),
        amountUsd: String(opts.amountUsd),
        idempotencyKey: opts.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  },

  async updateState(id, update) {
    await db
      .update(walletWithdrawals)
      .set({
        state: update.state,
        ...(update.relayerTransactionId !== undefined
          ? { relayerTransactionId: update.relayerTransactionId }
          : {}),
        ...(update.transactionHash !== undefined
          ? { transactionHash: update.transactionHash }
          : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(walletWithdrawals.id, id));
  },

  async findByIdempotencyKey(walletAddress, key) {
    const [row] = await db
      .select()
      .from(walletWithdrawals)
      .where(
        and(
          eq(walletWithdrawals.walletAddress, walletAddress.toLowerCase()),
          eq(walletWithdrawals.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async listByWallet(walletAddress, limit = 50) {
    return db
      .select()
      .from(walletWithdrawals)
      .where(eq(walletWithdrawals.walletAddress, walletAddress.toLowerCase()))
      .orderBy(desc(walletWithdrawals.createdAt))
      .limit(limit);
  },
});
