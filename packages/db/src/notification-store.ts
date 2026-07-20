import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  channelLinkCodes,
  notificationChannels,
  notificationOutbox,
  signLinkTokens,
  type ChannelLinkCodeRow,
  type NotificationChannelRow,
  type NotificationOutboxRow,
  type SignLinkTokenRow,
} from "./schema.js";

// ── Domain vocabulary ─────────────────────────────────────────────────────────

export const NOTIFICATION_CHANNEL_KINDS = ["telegram", "discord"] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

/**
 * Everything the app notifies about. order_awaiting_signature is the only kind
 * that carries a sign link; the rest are informational.
 */
export const NOTIFICATION_KINDS = [
  "order_awaiting_signature",
  "rule_alert",
  "order_auto_executed",
  "order_filled",
  "deposit_completed",
  "withdrawal_completed",
  /** A scheduled funds-arrival auto-retry gave up — manual confirm needed. */
  "auto_retry_abandoned",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationPreferences = Partial<Record<NotificationKind, boolean>>;

/** Default-on preference resolution: only an explicit `false` opts a kind out. */
export const isKindEnabled = (preferences: unknown, kind: NotificationKind): boolean => {
  if (preferences !== null && typeof preferences === "object") {
    return (preferences as Record<string, unknown>)[kind] !== false;
  }
  return true;
};

/** Terminal failure after this many delivery attempts. */
export const MAX_SEND_ATTEMPTS = 5;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 15 * 60_000;

/** Exponential outbox backoff: 5s, 15s, 45s, 135s, … capped at 15 minutes. */
export const nextRetryDelayMs = (attempts: number): number =>
  Math.min(BASE_RETRY_MS * 3 ** Math.max(0, attempts - 1), MAX_RETRY_MS);

// ── Channels ──────────────────────────────────────────────────────────────────

export interface NotificationChannelStore {
  /**
   * Activate a wallet ↔ external-account link. Any previous ACTIVE link for the
   * same (channel, externalId) — including one owned by another wallet — is
   * revoked first: an external account belongs to exactly one wallet at a time.
   */
  link(opts: {
    walletAddress: string;
    channel: NotificationChannelKind;
    externalId: string;
    externalUsername?: string | null;
  }): Promise<NotificationChannelRow>;
  listActiveByWallet(walletAddress: string): Promise<NotificationChannelRow[]>;
  findActiveByExternalId(
    channel: NotificationChannelKind,
    externalId: string,
  ): Promise<NotificationChannelRow | null>;
  findByIdForWallet(id: string, walletAddress: string): Promise<NotificationChannelRow | null>;
  revoke(id: string, walletAddress: string): Promise<NotificationChannelRow | null>;
  /** Bot-side unlink (e.g. /unlink in the chat). */
  revokeByExternalId(
    channel: NotificationChannelKind,
    externalId: string,
  ): Promise<NotificationChannelRow | null>;
  updatePreferences(
    id: string,
    walletAddress: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationChannelRow | null>;
}

export const createNotificationChannelStore = (db: Database): NotificationChannelStore => ({
  async link({ walletAddress, channel, externalId, externalUsername }) {
    await db
      .update(notificationChannels)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(
        and(
          eq(notificationChannels.channel, channel),
          eq(notificationChannels.externalId, externalId),
          eq(notificationChannels.status, "active"),
        ),
      );
    const [row] = await db
      .insert(notificationChannels)
      .values({ walletAddress, channel, externalId, externalUsername: externalUsername ?? null })
      .returning();
    if (!row) throw new Error("Failed to link notification channel");
    return row;
  },

  async listActiveByWallet(walletAddress) {
    return db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.walletAddress, walletAddress),
          eq(notificationChannels.status, "active"),
        ),
      )
      .orderBy(asc(notificationChannels.createdAt));
  },

  async findActiveByExternalId(channel, externalId) {
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.channel, channel),
          eq(notificationChannels.externalId, externalId),
          eq(notificationChannels.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findByIdForWallet(id, walletAddress) {
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(
        and(eq(notificationChannels.id, id), eq(notificationChannels.walletAddress, walletAddress)),
      )
      .limit(1);
    return row ?? null;
  },

  async revoke(id, walletAddress) {
    const [row] = await db
      .update(notificationChannels)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.walletAddress, walletAddress),
          eq(notificationChannels.status, "active"),
        ),
      )
      .returning();
    return row ?? null;
  },

  async revokeByExternalId(channel, externalId) {
    const [row] = await db
      .update(notificationChannels)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(
        and(
          eq(notificationChannels.channel, channel),
          eq(notificationChannels.externalId, externalId),
          eq(notificationChannels.status, "active"),
        ),
      )
      .returning();
    return row ?? null;
  },

  async updatePreferences(id, walletAddress, preferences) {
    const [row] = await db
      .update(notificationChannels)
      .set({ preferences })
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.walletAddress, walletAddress),
          eq(notificationChannels.status, "active"),
        ),
      )
      .returning();
    return row ?? null;
  },
});

// ── Link codes ────────────────────────────────────────────────────────────────

export interface LinkCodeStore {
  create(opts: {
    codeHash: string;
    walletAddress: string;
    channel: NotificationChannelKind;
    expiresAt: Date;
  }): Promise<ChannelLinkCodeRow>;
  /** Atomically consume an unused, unexpired code; null if invalid/replayed. */
  consume(codeHash: string): Promise<ChannelLinkCodeRow | null>;
}

export const createLinkCodeStore = (db: Database): LinkCodeStore => ({
  async create({ codeHash, walletAddress, channel, expiresAt }) {
    const [row] = await db
      .insert(channelLinkCodes)
      .values({ codeHash, walletAddress, channel, expiresAt })
      .returning();
    if (!row) throw new Error("Failed to create channel link code");
    return row;
  },

  async consume(codeHash) {
    const [row] = await db
      .update(channelLinkCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(channelLinkCodes.codeHash, codeHash),
          isNull(channelLinkCodes.usedAt),
          sql`${channelLinkCodes.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  },
});

// ── Outbox ────────────────────────────────────────────────────────────────────

export interface NotificationOutboxStore {
  /** Idempotent enqueue: a dedupe_key conflict returns null (already queued). */
  enqueue(opts: {
    walletAddress: string;
    kind: NotificationKind;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }): Promise<NotificationOutboxRow | null>;
  /** Due pending rows, oldest first. Single consumer (worker dispatcher). */
  claimDue(limit: number): Promise<NotificationOutboxRow[]>;
  markSent(id: string): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  /**
   * Record a failed delivery attempt: bumps attempts and either schedules the
   * backoff retry or fails terminally after MAX_SEND_ATTEMPTS.
   */
  markAttemptFailed(id: string, error: string): Promise<void>;
}

export const createNotificationOutboxStore = (db: Database): NotificationOutboxStore => ({
  async enqueue({ walletAddress, kind, dedupeKey, payload }) {
    const [row] = await db
      .insert(notificationOutbox)
      .values({ walletAddress, kind, dedupeKey, payload })
      .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
      .returning();
    return row ?? null;
  },

  async claimDue(limit) {
    return db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, "pending"),
          lte(notificationOutbox.nextAttemptAt, sql`now()`),
        ),
      )
      .orderBy(asc(notificationOutbox.createdAt))
      .limit(limit);
  },

  async markSent(id) {
    await db
      .update(notificationOutbox)
      .set({ status: "sent", sentAt: sql`now()` })
      .where(eq(notificationOutbox.id, id));
  },

  async markSkipped(id, reason) {
    await db
      .update(notificationOutbox)
      .set({ status: "skipped", lastError: reason })
      .where(eq(notificationOutbox.id, id));
  },

  async markAttemptFailed(id, error) {
    const [row] = await db
      .update(notificationOutbox)
      .set({ attempts: sql`${notificationOutbox.attempts} + 1`, lastError: error })
      .where(eq(notificationOutbox.id, id))
      .returning();
    if (!row) return;
    if (row.attempts >= MAX_SEND_ATTEMPTS) {
      await db
        .update(notificationOutbox)
        .set({ status: "failed" })
        .where(eq(notificationOutbox.id, id));
    } else {
      const delayMs = nextRetryDelayMs(row.attempts);
      await db
        .update(notificationOutbox)
        .set({ nextAttemptAt: new Date(Date.now() + delayMs) })
        .where(eq(notificationOutbox.id, id));
    }
  },
});

// ── Sign-link tokens ──────────────────────────────────────────────────────────

export interface SignLinkTokenStore {
  create(opts: {
    tokenHash: string;
    walletAddress: string;
    triggerId: string;
    expiresAt: Date;
  }): Promise<SignLinkTokenRow>;
  /** Atomically consume an unused, unexpired token; null if invalid/replayed. */
  consume(tokenHash: string): Promise<SignLinkTokenRow | null>;
}

export const createSignLinkTokenStore = (db: Database): SignLinkTokenStore => ({
  async create({ tokenHash, walletAddress, triggerId, expiresAt }) {
    const [row] = await db
      .insert(signLinkTokens)
      .values({ tokenHash, walletAddress, triggerId, expiresAt })
      .returning();
    if (!row) throw new Error("Failed to create sign-link token");
    return row;
  },

  async consume(tokenHash) {
    const [row] = await db
      .update(signLinkTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(signLinkTokens.tokenHash, tokenHash),
          isNull(signLinkTokens.usedAt),
          sql`${signLinkTokens.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  },
});
