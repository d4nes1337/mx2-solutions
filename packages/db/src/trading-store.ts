import { and, eq, desc, gte, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  userClobCredentials,
  tradingAccounts,
  tradingAccountClobCredentials,
  orderIntents,
  runtimeFlags,
  type UserClobCredentialRow,
  type TradingAccountRow,
  type TradingAccountClobCredentialRow,
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

// ── Trading account store ────────────────────────────────────────────────────

export type TradingAccountKind = "external_wallet" | "internal_privy";
export type TradingSigningMode = "browser" | "server" | "unavailable";
export type TradingAccountStatus =
  | "ready"
  | "needs_credentials"
  | "needs_deposit_wallet"
  | "needs_funding"
  | "needs_delegation"
  | "disabled";

export interface UpsertExternalTradingAccountOpts {
  ownerWalletAddress: string;
  signerAddress: string;
  funderAddress?: string | null;
  label?: string | null;
  makePrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpsertInternalPrivyTradingAccountOpts {
  ownerWalletAddress: string;
  signerAddress: string;
  privyWalletId: string;
  depositWalletAddress?: string | null;
  label?: string | null;
  status: TradingAccountStatus;
  makePrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TradingAccountStore {
  listByOwner(ownerWalletAddress: string): Promise<TradingAccountRow[]>;
  findByOwner(ownerWalletAddress: string, id: string): Promise<TradingAccountRow | null>;
  getPrimary(ownerWalletAddress: string): Promise<TradingAccountRow | null>;
  setPrimary(ownerWalletAddress: string, id: string): Promise<TradingAccountRow | null>;
  upsertExternal(opts: UpsertExternalTradingAccountOpts): Promise<TradingAccountRow>;
  upsertInternalPrivy(opts: UpsertInternalPrivyTradingAccountOpts): Promise<TradingAccountRow>;
  markReady(id: string): Promise<void>;
  updateStatus(id: string, status: TradingAccountStatus): Promise<void>;
  /** Soft-delete: stamps archivedAt, clears isPrimary, promotes next active account if needed. */
  archive(ownerWalletAddress: string, id: string): Promise<TradingAccountRow | null>;
}

const normalizeAddress = (address: string): string => address.toLowerCase();

const ensurePrimary = async (
  db: Database,
  ownerWalletAddress: string,
  id: string,
): Promise<void> => {
  await db
    .update(tradingAccounts)
    .set({ isPrimary: false, updatedAt: sql`now()` })
    .where(eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress));
  await db
    .update(tradingAccounts)
    .set({ isPrimary: true, updatedAt: sql`now()` })
    .where(eq(tradingAccounts.id, id));
};

const findAccountBySigner = async (
  db: Database,
  ownerWalletAddress: string,
  kind: TradingAccountKind,
  signerAddress: string,
): Promise<TradingAccountRow | null> => {
  const [row] = await db
    .select()
    .from(tradingAccounts)
    .where(
      and(
        eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress),
        eq(tradingAccounts.kind, kind),
        eq(tradingAccounts.signerAddress, signerAddress),
      ),
    )
    .limit(1);
  return row ?? null;
};

export const createTradingAccountStore = (db: Database): TradingAccountStore => ({
  async listByOwner(ownerWalletAddress) {
    return db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress),
          isNull(tradingAccounts.archivedAt),
        ),
      )
      .orderBy(desc(tradingAccounts.isPrimary), desc(tradingAccounts.updatedAt));
  },

  async findByOwner(ownerWalletAddress, id) {
    const [row] = await db
      .select()
      .from(tradingAccounts)
      .where(
        and(eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress), eq(tradingAccounts.id, id)),
      )
      .limit(1);
    return row ?? null;
  },

  async getPrimary(ownerWalletAddress) {
    const [row] = await db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress),
          eq(tradingAccounts.isPrimary, true),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async setPrimary(ownerWalletAddress, id) {
    const account = await this.findByOwner(ownerWalletAddress, id);
    if (!account) return null;
    await ensurePrimary(db, ownerWalletAddress, id);
    return { ...account, isPrimary: true };
  },

  async upsertExternal(opts) {
    const ownerWalletAddress = normalizeAddress(opts.ownerWalletAddress);
    const signerAddress = normalizeAddress(opts.signerAddress);
    const funderAddress = opts.funderAddress ? normalizeAddress(opts.funderAddress) : signerAddress;
    const existing = await findAccountBySigner(
      db,
      ownerWalletAddress,
      "external_wallet",
      signerAddress,
    );
    if (existing) {
      const [row] = await db
        .update(tradingAccounts)
        .set({
          label: opts.label ?? existing.label,
          funderAddress,
          status: existing.status === "ready" ? "ready" : "needs_credentials",
          metadata: opts.metadata ?? existing.metadata,
          updatedAt: sql`now()`,
        })
        .where(eq(tradingAccounts.id, existing.id))
        .returning();
      if (!row) throw new Error("Failed to update external trading account");
      if (opts.makePrimary) await ensurePrimary(db, ownerWalletAddress, row.id);
      return opts.makePrimary ? { ...row, isPrimary: true } : row;
    }

    const [row] = await db
      .insert(tradingAccounts)
      .values({
        ownerWalletAddress,
        kind: "external_wallet",
        label: opts.label ?? "Connected Polymarket wallet",
        signerAddress,
        funderAddress,
        signatureType: 2,
        signingMode: "browser",
        status: "needs_credentials",
        isPrimary: opts.makePrimary ?? false,
        metadata: opts.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("Failed to create external trading account");
    if (opts.makePrimary) await ensurePrimary(db, ownerWalletAddress, row.id);
    return opts.makePrimary ? { ...row, isPrimary: true } : row;
  },

  async upsertInternalPrivy(opts) {
    const ownerWalletAddress = normalizeAddress(opts.ownerWalletAddress);
    const signerAddress = normalizeAddress(opts.signerAddress);
    const depositWalletAddress = opts.depositWalletAddress
      ? normalizeAddress(opts.depositWalletAddress)
      : null;
    const existing = await findAccountBySigner(
      db,
      ownerWalletAddress,
      "internal_privy",
      signerAddress,
    );
    const funderAddress = depositWalletAddress;
    if (existing) {
      const [row] = await db
        .update(tradingAccounts)
        .set({
          label: opts.label ?? existing.label,
          funderAddress,
          signatureType: 3,
          signingMode: opts.status === "ready" ? "server" : "unavailable",
          status: opts.status,
          privyWalletId: opts.privyWalletId,
          depositWalletAddress,
          metadata: opts.metadata ?? existing.metadata,
          updatedAt: sql`now()`,
        })
        .where(eq(tradingAccounts.id, existing.id))
        .returning();
      if (!row) throw new Error("Failed to update internal trading account");
      if (opts.makePrimary) await ensurePrimary(db, ownerWalletAddress, row.id);
      return opts.makePrimary ? { ...row, isPrimary: true } : row;
    }

    const [row] = await db
      .insert(tradingAccounts)
      .values({
        ownerWalletAddress,
        kind: "internal_privy",
        label: opts.label ?? "Arima trading wallet",
        signerAddress,
        funderAddress,
        signatureType: 3,
        signingMode: opts.status === "ready" ? "server" : "unavailable",
        status: opts.status,
        isPrimary: opts.makePrimary ?? false,
        privyWalletId: opts.privyWalletId,
        depositWalletAddress,
        metadata: opts.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("Failed to create internal trading account");
    if (opts.makePrimary) await ensurePrimary(db, ownerWalletAddress, row.id);
    return opts.makePrimary ? { ...row, isPrimary: true } : row;
  },

  async markReady(id) {
    // Only flips `status`; signing mode is decided at account-creation time
    // (browser for external_wallet, server for internal_privy once
    // provisioned) and must not be overwritten here. The only caller today
    // is the external-wallet credential-setup flow, where stamping
    // signingMode "server" wrongly disabled manual browser-signed orders.
    await db
      .update(tradingAccounts)
      .set({ status: "ready", updatedAt: sql`now()` })
      .where(eq(tradingAccounts.id, id));
  },

  async updateStatus(id, status) {
    await db
      .update(tradingAccounts)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(tradingAccounts.id, id));
  },

  async archive(ownerWalletAddress, id) {
    const account = await this.findByOwner(ownerWalletAddress, id);
    if (!account || account.archivedAt) return null;

    const [archived] = await db
      .update(tradingAccounts)
      .set({ archivedAt: sql`now()`, isPrimary: false, updatedAt: sql`now()` })
      .where(
        and(eq(tradingAccounts.id, id), eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress)),
      )
      .returning();
    if (!archived) return null;

    // If it was primary, promote the next active account alphabetically by createdAt.
    if (account.isPrimary) {
      const [next] = await db
        .select()
        .from(tradingAccounts)
        .where(
          and(
            eq(tradingAccounts.ownerWalletAddress, ownerWalletAddress),
            isNull(tradingAccounts.archivedAt),
          ),
        )
        .orderBy(tradingAccounts.createdAt)
        .limit(1);
      if (next) await ensurePrimary(db, ownerWalletAddress, next.id);
    }

    return archived;
  },
});

// ── Account-scoped encrypted CLOB credential store ──────────────────────────

export interface TradingAccountClobCredentialStore {
  upsert(
    tradingAccountId: string,
    ownerWalletAddress: string,
    encryptedCreds: EncryptedCreds,
  ): Promise<TradingAccountClobCredentialRow>;
  find(tradingAccountId: string): Promise<TradingAccountClobCredentialRow | null>;
  delete(tradingAccountId: string): Promise<void>;
}

export const createTradingAccountClobCredentialStore = (
  db: Database,
): TradingAccountClobCredentialStore => ({
  async upsert(tradingAccountId, ownerWalletAddress, encryptedCreds) {
    const [row] = await db
      .insert(tradingAccountClobCredentials)
      .values({
        tradingAccountId,
        ownerWalletAddress: normalizeAddress(ownerWalletAddress),
        encryptedCreds,
      })
      .onConflictDoUpdate({
        target: tradingAccountClobCredentials.tradingAccountId,
        set: {
          ownerWalletAddress: normalizeAddress(ownerWalletAddress),
          encryptedCreds,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert account CLOB credentials");
    return row;
  },

  async find(tradingAccountId) {
    const [row] = await db
      .select()
      .from(tradingAccountClobCredentials)
      .where(eq(tradingAccountClobCredentials.tradingAccountId, tradingAccountId))
      .limit(1);
    return row ?? null;
  },

  async delete(tradingAccountId) {
    await db
      .delete(tradingAccountClobCredentials)
      .where(eq(tradingAccountClobCredentials.tradingAccountId, tradingAccountId));
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
  tradingAccountId?: string | null;
  idempotencyKey: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  orderType: string;
  funder?: string;
  signer?: string;
  signatureType?: number;
  signingMode?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderIntentStore {
  create(opts: CreateOrderIntentOpts): Promise<OrderIntentRow>;
  findByIdempotencyKey(key: string): Promise<OrderIntentRow | null>;
  findById(id: string): Promise<OrderIntentRow | null>;
  listByWallet(walletAddress: string, limit?: number): Promise<OrderIntentRow[]>;
  /** Count intents created at/after `since` for a wallet — the shared rate-limit gate. */
  countRecentByWallet(walletAddress: string, since: Date): Promise<number>;
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
      tradingAccountId: opts.tradingAccountId ?? null,
      idempotencyKey: opts.idempotencyKey,
      conditionId: opts.conditionId,
      tokenId: opts.tokenId,
      side: opts.side,
      price: opts.price,
      size: opts.size,
      orderType: opts.orderType,
      funder: opts.funder ?? null,
      signer: opts.signer ?? null,
      signatureType: opts.signatureType ?? null,
      signingMode: opts.signingMode ?? null,
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

  async countRecentByWallet(walletAddress, since) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orderIntents)
      .where(
        and(eq(orderIntents.walletAddress, walletAddress), gte(orderIntents.createdAt, since)),
      );
    return row?.count ?? 0;
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
