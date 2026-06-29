import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  privyWallets,
  tradingDelegations,
  type PrivyWalletRow,
  type TradingDelegationRow,
} from "./schema.js";

// ── Privy embedded-wallet store ───────────────────────────────────────────────

export interface UpsertPrivyWalletOpts {
  walletAddress: string;
  privyUserId: string;
  privyWalletId: string;
  embeddedAddress: string;
  policyId?: string | null;
}

export interface PrivyWalletStore {
  upsert(opts: UpsertPrivyWalletOpts): Promise<PrivyWalletRow>;
  find(walletAddress: string): Promise<PrivyWalletRow | null>;
  markAllowancesBootstrapped(walletAddress: string): Promise<void>;
}

export const createPrivyWalletStore = (db: Database): PrivyWalletStore => ({
  async upsert(opts) {
    const [row] = await db
      .insert(privyWallets)
      .values({
        walletAddress: opts.walletAddress,
        privyUserId: opts.privyUserId,
        privyWalletId: opts.privyWalletId,
        embeddedAddress: opts.embeddedAddress,
        policyId: opts.policyId ?? null,
      })
      .onConflictDoUpdate({
        target: privyWallets.walletAddress,
        set: {
          privyUserId: opts.privyUserId,
          privyWalletId: opts.privyWalletId,
          embeddedAddress: opts.embeddedAddress,
          policyId: opts.policyId ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert privy wallet");
    return row;
  },

  async find(walletAddress) {
    const [row] = await db
      .select()
      .from(privyWallets)
      .where(eq(privyWallets.walletAddress, walletAddress))
      .limit(1);
    return row ?? null;
  },

  async markAllowancesBootstrapped(walletAddress) {
    await db
      .update(privyWallets)
      .set({ allowancesBootstrappedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(privyWallets.walletAddress, walletAddress));
  },
});

// ── Trading delegation (session-signer consent) store ─────────────────────────

export interface CreateDelegationOpts {
  walletAddress: string;
  sessionSignerId?: string | null;
  expiresAt: Date;
}

export interface DelegationStore {
  create(opts: CreateDelegationOpts): Promise<TradingDelegationRow>;
  /** Active = status 'active' AND not past expiry. The signing authority gate. */
  findActive(walletAddress: string, now?: Date): Promise<TradingDelegationRow | null>;
  revoke(walletAddress: string): Promise<void>;
  /** Flip lapsed 'active' rows to 'expired' (audit hygiene / sweeper). */
  expireLapsed(walletAddress: string, now?: Date): Promise<void>;
}

export const createDelegationStore = (db: Database): DelegationStore => ({
  async create(opts) {
    // Supersede any prior active delegation for this wallet, then insert the new one.
    await db
      .update(tradingDelegations)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(
        and(
          eq(tradingDelegations.walletAddress, opts.walletAddress),
          eq(tradingDelegations.status, "active"),
        ),
      );
    const [row] = await db
      .insert(tradingDelegations)
      .values({
        walletAddress: opts.walletAddress,
        sessionSignerId: opts.sessionSignerId ?? null,
        expiresAt: opts.expiresAt,
      })
      .returning();
    if (!row) throw new Error("Failed to create trading delegation");
    return row;
  },

  async findActive(walletAddress, now = new Date()) {
    const [row] = await db
      .select()
      .from(tradingDelegations)
      .where(
        and(
          eq(tradingDelegations.walletAddress, walletAddress),
          eq(tradingDelegations.status, "active"),
          gt(tradingDelegations.expiresAt, now),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async revoke(walletAddress) {
    await db
      .update(tradingDelegations)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(
        and(
          eq(tradingDelegations.walletAddress, walletAddress),
          eq(tradingDelegations.status, "active"),
        ),
      );
  },

  async expireLapsed(walletAddress, now = new Date()) {
    await db
      .update(tradingDelegations)
      .set({ status: "expired" })
      .where(
        and(
          eq(tradingDelegations.walletAddress, walletAddress),
          eq(tradingDelegations.status, "active"),
          sql`${tradingDelegations.expiresAt} <= ${now}`,
        ),
      );
  },
});
