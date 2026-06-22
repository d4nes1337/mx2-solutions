import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  authChallenges,
  users,
  sessions,
  allowlist,
  type AuthChallengeRow,
  type UserRow,
  type SessionRow,
  type AllowlistRow,
} from "./schema.js";

// ── Challenges ────────────────────────────────────────────────────────────────

export interface ChallengeStore {
  create(opts: {
    nonce: string;
    walletAddress: string;
    chainId: number;
    issuedAt: string;
    expiresAt: Date;
  }): Promise<AuthChallengeRow>;
  findByNonce(nonce: string): Promise<AuthChallengeRow | null>;
  markUsed(nonce: string): Promise<void>;
}

export const createChallengeStore = (db: Database): ChallengeStore => ({
  async create({ nonce, walletAddress, chainId, issuedAt, expiresAt }) {
    const [row] = await db
      .insert(authChallenges)
      .values({ nonce, walletAddress, chainId, expiresAt, createdAt: new Date(issuedAt) })
      .returning();
    if (!row) throw new Error("Failed to insert auth challenge");
    return row;
  },

  async findByNonce(nonce) {
    const [row] = await db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.nonce, nonce))
      .limit(1);
    return row ?? null;
  },

  async markUsed(nonce) {
    await db
      .update(authChallenges)
      .set({ usedAt: sql`now()` })
      .where(eq(authChallenges.nonce, nonce));
  },
});

// ── Users ─────────────────────────────────────────────────────────────────────

export interface UserStore {
  upsert(walletAddress: string): Promise<UserRow>;
  findByWallet(walletAddress: string): Promise<UserRow | null>;
}

export const createUserStore = (db: Database): UserStore => ({
  async upsert(walletAddress) {
    const [row] = await db
      .insert(users)
      .values({ walletAddress })
      .onConflictDoUpdate({
        target: users.walletAddress,
        set: { lastSeenAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert user");
    return row;
  },

  async findByWallet(walletAddress) {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, walletAddress))
      .limit(1);
    return row ?? null;
  },
});

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface SessionStore {
  create(opts: { userWallet: string; tokenHash: string; expiresAt: Date }): Promise<SessionRow>;
  /** Returns the session only if it exists, has not expired, and has not been revoked. */
  findByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  revoke(tokenHash: string): Promise<void>;
}

export const createSessionStore = (db: Database): SessionStore => ({
  async create({ userWallet, tokenHash, expiresAt }) {
    const [row] = await db
      .insert(sessions)
      .values({ userWallet, tokenHash, expiresAt })
      .returning();
    if (!row) throw new Error("Failed to create session");
    return row;
  },

  async findByTokenHash(tokenHash) {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt !== null || row.expiresAt < new Date()) return null;
    return row;
  },

  async revoke(tokenHash) {
    await db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.tokenHash, tokenHash));
  },
});

// ── Allowlist ─────────────────────────────────────────────────────────────────

export interface AllowlistStore {
  isAllowed(walletAddress: string): Promise<boolean>;
  findEntry(walletAddress: string): Promise<AllowlistRow | null>;
  add(walletAddress: string, addedBy: string, note: string | null): Promise<AllowlistRow>;
  remove(walletAddress: string): Promise<void>;
}

export const createAllowlistStore = (db: Database): AllowlistStore => ({
  async isAllowed(walletAddress) {
    const [row] = await db
      .select({ isActive: allowlist.isActive })
      .from(allowlist)
      .where(eq(allowlist.walletAddress, walletAddress))
      .limit(1);
    return row?.isActive === true;
  },

  async findEntry(walletAddress) {
    const [row] = await db
      .select()
      .from(allowlist)
      .where(eq(allowlist.walletAddress, walletAddress))
      .limit(1);
    return row ?? null;
  },

  async add(walletAddress, addedBy, note) {
    const values =
      note !== null
        ? { walletAddress, addedBy, note, isActive: true as const, removedAt: null }
        : { walletAddress, addedBy, isActive: true as const, removedAt: null };
    const [row] = await db
      .insert(allowlist)
      .values(values)
      .onConflictDoUpdate({
        target: allowlist.walletAddress,
        set: { addedBy, isActive: true, removedAt: null },
      })
      .returning();
    if (!row) throw new Error("Failed to add allowlist entry");
    return row;
  },

  async remove(walletAddress) {
    await db
      .update(allowlist)
      .set({ isActive: false, removedAt: sql`now()` })
      .where(eq(allowlist.walletAddress, walletAddress));
  },
});
