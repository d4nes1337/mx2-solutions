import { eq, desc, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  userClobCredentials,
  orderIntents,
  runtimeFlags,
  type UserClobCredentialRow,
  type OrderIntentRow,
  type NewOrderIntentRow,
  type RuntimeFlagRow,
} from "./schema.js";

// ── Encrypted CLOB credential store ──────────────────────────────────────────

export interface EncryptedCreds {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: number;
}

export interface ClobCredentialStore {
  upsert(walletAddress: string, encryptedCreds: EncryptedCreds): Promise<UserClobCredentialRow>;
  find(walletAddress: string): Promise<UserClobCredentialRow | null>;
  delete(walletAddress: string): Promise<void>;
}

export const createClobCredentialStore = (db: Database): ClobCredentialStore => ({
  async upsert(walletAddress, encryptedCreds) {
    const [row] = await db
      .insert(userClobCredentials)
      .values({ walletAddress, encryptedCreds })
      .onConflictDoUpdate({
        target: userClobCredentials.walletAddress,
        set: { encryptedCreds, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert CLOB credentials");
    return row;
  },

  async find(walletAddress) {
    const [row] = await db
      .select()
      .from(userClobCredentials)
      .where(eq(userClobCredentials.walletAddress, walletAddress))
      .limit(1);
    return row ?? null;
  },

  async delete(walletAddress) {
    await db
      .delete(userClobCredentials)
      .where(eq(userClobCredentials.walletAddress, walletAddress));
  },
});

// ── Order intent store ────────────────────────────────────────────────────────

export type OrderIntentStatus =
  | "pending"
  | "submitted"
  | "acknowledged"
  | "filled"
  | "cancelled"
  | "failed"
  | "unknown";

export interface CreateOrderIntentOpts {
  walletAddress: string;
  idempotencyKey: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  orderType: string;
  funder?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderIntentStore {
  create(opts: CreateOrderIntentOpts): Promise<OrderIntentRow>;
  findByIdempotencyKey(key: string): Promise<OrderIntentRow | null>;
  findById(id: string): Promise<OrderIntentRow | null>;
  listByWallet(walletAddress: string, limit?: number): Promise<OrderIntentRow[]>;
  updateStatus(
    id: string,
    status: OrderIntentStatus,
    extra?: { clobOrderId?: string; errorMessage?: string },
  ): Promise<void>;
}

export const createOrderIntentStore = (db: Database): OrderIntentStore => ({
  async create(opts) {
    const values: NewOrderIntentRow = {
      walletAddress: opts.walletAddress,
      idempotencyKey: opts.idempotencyKey,
      conditionId: opts.conditionId,
      tokenId: opts.tokenId,
      side: opts.side,
      price: opts.price,
      size: opts.size,
      orderType: opts.orderType,
      funder: opts.funder ?? null,
      status: "pending",
      metadata: opts.metadata ?? {},
    };
    const [row] = await db.insert(orderIntents).values(values).returning();
    if (!row) throw new Error("Failed to create order intent");
    return row;
  },

  async findByIdempotencyKey(key) {
    const [row] = await db
      .select()
      .from(orderIntents)
      .where(eq(orderIntents.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  },

  async findById(id) {
    const [row] = await db.select().from(orderIntents).where(eq(orderIntents.id, id)).limit(1);
    return row ?? null;
  },

  async listByWallet(walletAddress, limit = 50) {
    return db
      .select()
      .from(orderIntents)
      .where(eq(orderIntents.walletAddress, walletAddress))
      .orderBy(desc(orderIntents.createdAt))
      .limit(limit);
  },

  async updateStatus(id, status, extra) {
    await db
      .update(orderIntents)
      .set({
        status,
        updatedAt: sql`now()`,
        ...(extra?.clobOrderId !== undefined ? { clobOrderId: extra.clobOrderId } : {}),
        ...(extra?.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
      })
      .where(eq(orderIntents.id, id));
  },
});

// ── Runtime flags (kill switch) ───────────────────────────────────────────────

export interface RuntimeFlagStore {
  get(key: string): Promise<RuntimeFlagRow | null>;
  set(key: string, value: string, updatedBy: string): Promise<RuntimeFlagRow>;
}

export const createRuntimeFlagStore = (db: Database): RuntimeFlagStore => ({
  async get(key) {
    const [row] = await db.select().from(runtimeFlags).where(eq(runtimeFlags.key, key)).limit(1);
    return row ?? null;
  },

  async set(key, value, updatedBy) {
    const [row] = await db
      .insert(runtimeFlags)
      .values({ key, value, updatedBy })
      .onConflictDoUpdate({
        target: runtimeFlags.key,
        set: { value, updatedBy, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error("Failed to set runtime flag");
    return row;
  },
});
