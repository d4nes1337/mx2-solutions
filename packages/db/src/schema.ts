import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";

/**
 * Append-only audit log. Rows are immutable: the application never issues
 * UPDATE or DELETE against this table. Retention/archival is handled out of
 * band (see docs/07 operations). See packages/core AuditAction for the
 * controlled action vocabulary.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subject: text("subject"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_actor_idx").on(t.actor),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_created_at_idx").on(t.createdAt),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

/**
 * Live orderbook snapshots written by the WebSocket worker. Mutable (UPSERT on
 * token_id). isStale=true when the WS channel has gone quiet beyond the
 * staleness threshold; the API surfaces this to prevent misleading UI state.
 */
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    tokenId: text("token_id").primaryKey(),
    conditionId: text("condition_id").notNull(),
    bids: jsonb("bids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    asks: jsonb("asks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastTradePrice: text("last_trade_price"),
    midPrice: text("mid_price"),
    source: text("source").notNull().default("rest"),
    isStale: boolean("is_stale").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("market_snapshots_condition_id_idx").on(t.conditionId),
    index("market_snapshots_updated_at_idx").on(t.updatedAt),
  ],
);

export type MarketSnapshotRow = typeof marketSnapshots.$inferSelect;
export type NewMarketSnapshotRow = typeof marketSnapshots.$inferInsert;

/**
 * Short-lived EIP-712 login nonces. Each entry is consumed at most once and
 * expires in 5 minutes. The application never reuses a nonce.
 */
export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    nonce: text("nonce").notNull().unique(),
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull().default(137),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_challenges_nonce_idx").on(t.nonce)],
);

export type AuthChallengeRow = typeof authChallenges.$inferSelect;

/** Minimal identity record — one row per unique wallet address. */
export const users = pgTable("users", {
  walletAddress: text("wallet_address").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;

/**
 * DB-backed sessions. The cookie holds the raw 32-byte hex token; the DB
 * stores only SHA256(token) so a DB compromise does not yield live tokens.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userWallet: text("user_wallet").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_user_wallet_idx").on(t.userWallet),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;

/** Admin-managed beta allowlist. Only wallets with is_active=true may log in. */
export const allowlist = pgTable("allowlist", {
  walletAddress: text("wallet_address").primaryKey(),
  addedBy: text("added_by").notNull(),
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

export type AllowlistRow = typeof allowlist.$inferSelect;

/**
 * Per-user encrypted L2 CLOB API credentials.
 * encryptedCreds holds AES-256-GCM ciphertext (iv + ciphertext + authTag + keyVersion).
 * The raw creds (apiKey, secret, passphrase) never leave the server unencrypted.
 * Re-derivable at any time if the user re-provides an L1 CLOB signature.
 */
export const userClobCredentials = pgTable("user_clob_credentials", {
  walletAddress: text("wallet_address").primaryKey(),
  encryptedCreds: jsonb("encrypted_creds").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserClobCredentialRow = typeof userClobCredentials.$inferSelect;

/**
 * Idempotent order intents — one row per user intent to place an order.
 * idempotency_key is client-supplied and prevents double-submit.
 * status machine: pending → submitted → acknowledged → filled | cancelled | failed | unknown
 */
export const orderIntents = pgTable(
  "order_intents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    side: text("side").notNull(),
    price: text("price").notNull(),
    size: text("size").notNull(),
    orderType: text("order_type").notNull(),
    funder: text("funder"),
    status: text("status").notNull().default("pending"),
    clobOrderId: text("clob_order_id"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_intents_wallet_idx").on(t.walletAddress),
    index("order_intents_idempotency_key_idx").on(t.idempotencyKey),
    index("order_intents_status_idx").on(t.status),
  ],
);

export type OrderIntentRow = typeof orderIntents.$inferSelect;
export type NewOrderIntentRow = typeof orderIntents.$inferInsert;

/**
 * DB-backed runtime flags for kill switches and runtime configuration.
 * Key examples: 'trading_paused' (value: 'true'/'false').
 * Changes take effect immediately without redeploying the process.
 */
export const runtimeFlags = pgTable("runtime_flags", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RuntimeFlagRow = typeof runtimeFlags.$inferSelect;
