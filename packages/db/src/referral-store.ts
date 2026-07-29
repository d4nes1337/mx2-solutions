import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  referralCodes,
  referralRedemptions,
  type ReferralCodeRow,
  type ReferralRedemptionRow,
} from "./schema.js";

// ── Code format ───────────────────────────────────────────────────────────────

/** No 0/O/1/I/L — codes survive being read aloud or hand-copied from a chat. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Canonical stored form; also what admin-supplied vanity codes must match. */
export const REFERRAL_CODE_RE = /^[A-Z0-9]{3,20}$/;

export const normalizeReferralCode = (input: string): string => input.trim().toUpperCase();

export const isValidReferralCode = (code: string): boolean => REFERRAL_CODE_RE.test(code);

/** 6 chars over a 31-char alphabet ≈ 900M — plenty against rate-limited guessing. */
export const generateReferralCode = (length = 6): string => {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(16)) {
      const v = byte & 0x1f;
      if (v < CODE_ALPHABET.length && out.length < length) out += CODE_ALPHABET[v];
    }
  }
  return out;
};

// ── Store ─────────────────────────────────────────────────────────────────────

export type ReferralRedeemResult =
  | { outcome: "redeemed"; code: ReferralCodeRow; redemption: ReferralRedemptionRow }
  /** Same wallet replaying the same code — idempotent success (mid-login retry). */
  | {
      outcome: "already_redeemed_by_wallet";
      code: ReferralCodeRow;
      redemption: ReferralRedemptionRow;
    }
  | {
      outcome: "rejected";
      reason: "not_found" | "exhausted" | "disabled" | "expired" | "wallet_already_referred";
    };

export interface ReferralCodeStats {
  codeId: string;
  refereeCount: number;
}

export interface ReferralStore {
  /**
   * Get-or-create the wallet's personal code. Idempotent per wallet; a rare
   * concurrent double-create leaves two owned codes, which is harmless (the
   * earliest active one is treated as primary everywhere).
   */
  ensurePersonalCode(ownerWallet: string, defaultMaxUses: number): Promise<ReferralCodeRow>;
  /**
   * Atomic capped redemption. One guarded UPDATE increments used_count only
   * while seats remain and the code is enabled/unexpired; the redemption row
   * insert shares the transaction, so a lost race rolls everything back.
   * A wallet can be referred exactly once, ever (UNIQUE wallet_address) —
   * a revoked user cannot re-enter through a different code.
   */
  redeem(rawCode: string, walletAddress: string): Promise<ReferralRedeemResult>;
  /** Admin mint (vanity/VIP/campaign). Throws on duplicate code (23505). */
  createCode(opts: {
    code?: string;
    ownerWallet: string | null;
    maxUses: number;
    note: string | null;
    createdBy: string;
    expiresAt: Date | null;
  }): Promise<ReferralCodeRow>;
  findById(id: string): Promise<ReferralCodeRow | null>;
  findByCode(rawCode: string): Promise<ReferralCodeRow | null>;
  /** All codes owned by a wallet, earliest first (first active = primary). */
  codesForOwner(ownerWallet: string): Promise<ReferralCodeRow[]>;
  setMaxUses(id: string, maxUses: number): Promise<ReferralCodeRow | null>;
  setNote(id: string, note: string | null): Promise<ReferralCodeRow | null>;
  setDisabled(id: string, disabled: boolean, actor: string): Promise<ReferralCodeRow | null>;
  reassignOwner(id: string, ownerWallet: string | null): Promise<ReferralCodeRow | null>;
  list(): Promise<ReferralCodeRow[]>;
  redemptionsForCode(codeId: string): Promise<ReferralRedemptionRow[]>;
  /** The redemption that brought this wallet in, if any. */
  redemptionForWallet(walletAddress: string): Promise<ReferralRedemptionRow | null>;
  listRedemptions(): Promise<ReferralRedemptionRow[]>;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";

export const createReferralStore = (db: Database): ReferralStore => {
  const findByCode = async (rawCode: string): Promise<ReferralCodeRow | null> => {
    const code = normalizeReferralCode(rawCode);
    if (!isValidReferralCode(code)) return null;
    const [row] = await db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.code, code))
      .limit(1);
    return row ?? null;
  };

  return {
    async ensurePersonalCode(ownerWallet, defaultMaxUses) {
      const wallet = ownerWallet.toLowerCase();
      const [existing] = await db
        .select()
        .from(referralCodes)
        .where(and(eq(referralCodes.ownerWallet, wallet), isNull(referralCodes.disabledAt)))
        .orderBy(asc(referralCodes.createdAt))
        .limit(1);
      if (existing) return existing;

      // Retry on the (astronomically rare) generated-code collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const [row] = await db
            .insert(referralCodes)
            .values({
              code: generateReferralCode(),
              ownerWallet: wallet,
              maxUses: defaultMaxUses,
              note: null,
              createdBy: "system:auto",
              expiresAt: null,
            })
            .returning();
          if (!row) throw new Error("Failed to create personal referral code");
          return row;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new Error("Could not generate a unique referral code");
    },

    async redeem(rawCode, walletAddress) {
      const wallet = walletAddress.toLowerCase();
      const code = await findByCode(rawCode);
      if (!code) return { outcome: "rejected", reason: "not_found" };

      const [priorRedemption] = await db
        .select()
        .from(referralRedemptions)
        .where(eq(referralRedemptions.walletAddress, wallet))
        .limit(1);
      if (priorRedemption) {
        return priorRedemption.codeId === code.id
          ? { outcome: "already_redeemed_by_wallet", code, redemption: priorRedemption }
          : { outcome: "rejected", reason: "wallet_already_referred" };
      }

      try {
        return await db.transaction(async (tx) => {
          const [claimed] = await tx
            .update(referralCodes)
            .set({ usedCount: sql`${referralCodes.usedCount} + 1` })
            .where(
              and(
                eq(referralCodes.id, code.id),
                sql`${referralCodes.usedCount} < ${referralCodes.maxUses}`,
                isNull(referralCodes.disabledAt),
                sql`(${referralCodes.expiresAt} IS NULL OR ${referralCodes.expiresAt} > now())`,
              ),
            )
            .returning();

          if (!claimed) {
            // Diagnose from a fresh read; all guards only move one way except
            // used_count, where "no seats now" is the honest answer anyway.
            const [current] = await tx
              .select()
              .from(referralCodes)
              .where(eq(referralCodes.id, code.id))
              .limit(1);
            if (!current) return { outcome: "rejected" as const, reason: "not_found" as const };
            if (current.disabledAt !== null)
              return { outcome: "rejected" as const, reason: "disabled" as const };
            if (current.expiresAt !== null && current.expiresAt <= new Date())
              return { outcome: "rejected" as const, reason: "expired" as const };
            return { outcome: "rejected" as const, reason: "exhausted" as const };
          }

          const [redemption] = await tx
            .insert(referralRedemptions)
            .values({
              codeId: claimed.id,
              walletAddress: wallet,
              referrerWallet: claimed.ownerWallet,
            })
            .returning();
          if (!redemption) throw new Error("Failed to record referral redemption");
          return { outcome: "redeemed" as const, code: claimed, redemption };
        });
      } catch (error) {
        // Concurrent redemption by the same wallet: the UNIQUE(wallet_address)
        // insert lost the race and the transaction rolled the seat back.
        if (isUniqueViolation(error)) {
          const [existing] = await db
            .select()
            .from(referralRedemptions)
            .where(eq(referralRedemptions.walletAddress, wallet))
            .limit(1);
          if (existing && existing.codeId === code.id) {
            return { outcome: "already_redeemed_by_wallet", code, redemption: existing };
          }
          return { outcome: "rejected", reason: "wallet_already_referred" };
        }
        throw error;
      }
    },

    async createCode({ code, ownerWallet, maxUses, note, createdBy, expiresAt }) {
      const canonical = code ? normalizeReferralCode(code) : generateReferralCode();
      if (!isValidReferralCode(canonical)) {
        throw new Error(`Invalid referral code format: ${canonical}`);
      }
      const [row] = await db
        .insert(referralCodes)
        .values({
          code: canonical,
          ownerWallet: ownerWallet?.toLowerCase() ?? null,
          maxUses,
          note,
          createdBy,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error("Failed to create referral code");
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(referralCodes).where(eq(referralCodes.id, id)).limit(1);
      return row ?? null;
    },

    findByCode,

    async codesForOwner(ownerWallet) {
      return db
        .select()
        .from(referralCodes)
        .where(eq(referralCodes.ownerWallet, ownerWallet.toLowerCase()))
        .orderBy(asc(referralCodes.createdAt));
    },

    async setMaxUses(id, maxUses) {
      const [row] = await db
        .update(referralCodes)
        .set({ maxUses })
        .where(eq(referralCodes.id, id))
        .returning();
      return row ?? null;
    },

    async setNote(id, note) {
      const [row] = await db
        .update(referralCodes)
        .set({ note })
        .where(eq(referralCodes.id, id))
        .returning();
      return row ?? null;
    },

    async setDisabled(id, disabled, actor) {
      const [row] = await db
        .update(referralCodes)
        .set(
          disabled
            ? { disabledAt: sql`now()`, disabledBy: actor }
            : { disabledAt: null, disabledBy: null },
        )
        .where(eq(referralCodes.id, id))
        .returning();
      return row ?? null;
    },

    async reassignOwner(id, ownerWallet) {
      const [row] = await db
        .update(referralCodes)
        .set({ ownerWallet: ownerWallet?.toLowerCase() ?? null })
        .where(eq(referralCodes.id, id))
        .returning();
      return row ?? null;
    },

    async list() {
      return db.select().from(referralCodes).orderBy(desc(referralCodes.createdAt));
    },

    async redemptionsForCode(codeId) {
      return db
        .select()
        .from(referralRedemptions)
        .where(eq(referralRedemptions.codeId, codeId))
        .orderBy(desc(referralRedemptions.redeemedAt));
    },

    async redemptionForWallet(walletAddress) {
      const [row] = await db
        .select()
        .from(referralRedemptions)
        .where(eq(referralRedemptions.walletAddress, walletAddress.toLowerCase()))
        .limit(1);
      return row ?? null;
    },

    async listRedemptions() {
      return db.select().from(referralRedemptions).orderBy(desc(referralRedemptions.redeemedAt));
    },
  };
};
