import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  invitations,
  waitlistEntries,
  type InvitationRow,
  type WaitlistEntryRow,
  type WaitlistStatus,
} from "./schema.js";

// ── Waitlist ──────────────────────────────────────────────────────────────────

export interface WaitlistStore {
  /**
   * Upsert: by lowercased email when present, else by wallet address (the
   * route guarantees at least one). A resubmission refreshes the profile
   * fields but keeps the original consent timestamp and status (a rejected/
   * withdrawn entry is not silently resurrected by re-joining).
   */
  submit(entry: {
    email: string | null;
    socialHandle: string | null;
    walletAddress: string | null;
    tradingFrequency: string | null;
    useCase: string | null;
    referral: string | null;
    consentAt: Date;
  }): Promise<WaitlistEntryRow>;
  list(status?: WaitlistStatus): Promise<WaitlistEntryRow[]>;
  findById(id: string): Promise<WaitlistEntryRow | null>;
  updateStatus(id: string, status: WaitlistStatus): Promise<WaitlistEntryRow | null>;
}

export const createWaitlistStore = (db: Database): WaitlistStore => ({
  async submit(entry) {
    const email = entry.email?.trim().toLowerCase() || null;
    const profile = {
      socialHandle: entry.socialHandle,
      tradingFrequency: entry.tradingFrequency,
      useCase: entry.useCase,
      referral: entry.referral,
    };

    if (email) {
      const [row] = await db
        .insert(waitlistEntries)
        .values({ ...entry, email })
        .onConflictDoUpdate({
          target: waitlistEntries.email,
          set: { ...profile, walletAddress: entry.walletAddress, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error("Failed to upsert waitlist entry");
      return row;
    }

    // Wallet-only join: dedupe by wallet in the store (no DB uniqueness so an
    // email row may also carry the wallet). Race window is irrelevant at
    // beta scale — worst case is a duplicate queue row the owner merges.
    const wallet = entry.walletAddress;
    if (!wallet) throw new Error("waitlist entry needs an email or a wallet address");
    const [existing] = await db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.walletAddress, wallet))
      .orderBy(desc(waitlistEntries.createdAt))
      .limit(1);
    if (existing) {
      const [row] = await db
        .update(waitlistEntries)
        .set({ ...profile, updatedAt: sql`now()` })
        .where(eq(waitlistEntries.id, existing.id))
        .returning();
      if (!row) throw new Error("Failed to update waitlist entry");
      return row;
    }
    const [row] = await db.insert(waitlistEntries).values(entry).returning();
    if (!row) throw new Error("Failed to insert waitlist entry");
    return row;
  },

  async list(status) {
    const base = db.select().from(waitlistEntries);
    const rows = status
      ? await base
          .where(eq(waitlistEntries.status, status))
          .orderBy(desc(waitlistEntries.createdAt))
      : await base.orderBy(desc(waitlistEntries.createdAt));
    return rows;
  },

  async findById(id) {
    const [row] = await db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, id))
      .limit(1);
    return row ?? null;
  },

  async updateStatus(id, status) {
    const [row] = await db
      .update(waitlistEntries)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(waitlistEntries.id, id))
      .returning();
    return row ?? null;
  },
});

// ── Invitations ───────────────────────────────────────────────────────────────

export type InvitationRedeemResult =
  | { outcome: "redeemed"; invitation: InvitationRow }
  /** Same wallet presenting an already-redeemed code — idempotent success. */
  | { outcome: "already_redeemed_by_wallet"; invitation: InvitationRow }
  | { outcome: "rejected"; reason: "not_found" | "expired" | "revoked" | "redeemed_by_other" };

export interface InvitationStore {
  create(opts: {
    codeHash: string;
    issuedBy: string;
    note: string | null;
    expiresAt: Date;
    waitlistEntryId: string | null;
  }): Promise<InvitationRow>;
  findById(id: string): Promise<InvitationRow | null>;
  findByCodeHash(codeHash: string): Promise<InvitationRow | null>;
  /**
   * Atomic single-use redemption: exactly one UPDATE guarded by
   * redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now().
   * Losing the race (or replaying) never re-redeems; a replay by the SAME
   * wallet reports idempotent success so a mid-login retry cannot strand the
   * user between "code consumed" and "allowlisted".
   */
  redeem(codeHash: string, walletAddress: string): Promise<InvitationRedeemResult>;
  revoke(id: string, revokedBy: string): Promise<InvitationRow | null>;
  list(): Promise<InvitationRow[]>;
}

export const createInvitationStore = (db: Database): InvitationStore => {
  const findByCodeHash = async (codeHash: string): Promise<InvitationRow | null> => {
    const [row] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.codeHash, codeHash))
      .limit(1);
    return row ?? null;
  };

  return {
    async create({ codeHash, issuedBy, note, expiresAt, waitlistEntryId }) {
      const [row] = await db
        .insert(invitations)
        .values({ codeHash, issuedBy, note, expiresAt, waitlistEntryId })
        .returning();
      if (!row) throw new Error("Failed to create invitation");
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
      return row ?? null;
    },

    findByCodeHash,

    async redeem(codeHash, walletAddress) {
      const [updated] = await db
        .update(invitations)
        .set({ redeemedBy: walletAddress, redeemedAt: sql`now()` })
        .where(
          and(
            eq(invitations.codeHash, codeHash),
            isNull(invitations.redeemedAt),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > now()`,
          ),
        )
        .returning();
      if (updated) return { outcome: "redeemed", invitation: updated };

      // The guarded UPDATE matched nothing — explain why without racing:
      // the row's terminal fields only ever move one way (redeemed/revoked
      // timestamps are never cleared), so this read is stable.
      const existing = await findByCodeHash(codeHash);
      if (!existing) return { outcome: "rejected", reason: "not_found" };
      if (existing.revokedAt !== null) return { outcome: "rejected", reason: "revoked" };
      if (existing.redeemedAt !== null) {
        return existing.redeemedBy === walletAddress
          ? { outcome: "already_redeemed_by_wallet", invitation: existing }
          : { outcome: "rejected", reason: "redeemed_by_other" };
      }
      return { outcome: "rejected", reason: "expired" };
    },

    async revoke(id, revokedBy) {
      const [row] = await db
        .update(invitations)
        .set({ revokedAt: sql`now()`, revokedBy })
        .where(and(eq(invitations.id, id), isNull(invitations.revokedAt)))
        .returning();
      return row ?? null;
    },

    async list() {
      return db.select().from(invitations).orderBy(desc(invitations.createdAt));
    },
  };
};
