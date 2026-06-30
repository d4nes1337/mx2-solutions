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
 * User-selectable trading accounts. A login wallet can own many trading accounts:
 * external Polymarket wallets that require browser signatures, and internal
 * Privy/deposit-wallet accounts that become no-popup once the relayer flow is
 * complete. The selected/primary row is the default funding + signing context
 * for order preview, submit, cancel, and CLOB credentials.
 */
export const tradingAccounts = pgTable(
  "trading_accounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerWalletAddress: text("owner_wallet_address").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    signerAddress: text("signer_address").notNull(),
    funderAddress: text("funder_address"),
    signatureType: integer("signature_type").notNull(),
    signingMode: text("signing_mode").notNull(),
    status: text("status").notNull().default("needs_credentials"),
    isPrimary: boolean("is_primary").notNull().default(false),
    privyWalletId: text("privy_wallet_id"),
    depositWalletAddress: text("deposit_wallet_address"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trading_accounts_owner_idx").on(t.ownerWalletAddress),
    index("trading_accounts_owner_primary_idx").on(t.ownerWalletAddress, t.isPrimary),
    index("trading_accounts_signer_idx").on(t.signerAddress),
  ],
);

export type TradingAccountRow = typeof tradingAccounts.$inferSelect;
export type NewTradingAccountRow = typeof tradingAccounts.$inferInsert;

/**
 * Per-trading-account encrypted L2 CLOB API credentials. New multi-wallet flows
 * use this table. user_clob_credentials remains for legacy single-wallet rows
 * and compatibility while the migration rolls forward.
 */
export const tradingAccountClobCredentials = pgTable(
  "trading_account_clob_credentials",
  {
    tradingAccountId: uuid("trading_account_id").primaryKey(),
    ownerWalletAddress: text("owner_wallet_address").notNull(),
    encryptedCreds: jsonb("encrypted_creds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trading_account_clob_credentials_owner_idx").on(t.ownerWalletAddress)],
);

export type TradingAccountClobCredentialRow = typeof tradingAccountClobCredentials.$inferSelect;

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
    tradingAccountId: uuid("trading_account_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    side: text("side").notNull(),
    price: text("price").notNull(),
    size: text("size").notNull(),
    orderType: text("order_type").notNull(),
    funder: text("funder"),
    signer: text("signer"),
    signatureType: integer("signature_type"),
    signingMode: text("signing_mode"),
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
    index("order_intents_trading_account_idx").on(t.tradingAccountId),
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

/**
 * Conditional rules (docs/04). One row per user rule. `definition` holds the
 * immutable RuleDefinition (@mx2/rules); `definitionHash` ties triggers to the
 * exact version. The worker is the single writer of evaluation-driven columns
 * (`status` when ACTIVE_*, `trueSince`, `lastEvaluatedAt`); the API owns the
 * user-control transitions (PAUSED/CANCELLED) — see the conditional updates in
 * conditional-store.ts. Evaluation state never auto-submits an order; a trigger
 * only produces a rule_triggers row awaiting manual confirmation.
 */
export const conditionalRules = pgTable(
  "conditional_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    conditionId: text("condition_id").notNull(),
    tokenId: text("token_id").notNull(),
    side: text("side").notNull(),
    definition: jsonb("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    status: text("status").notNull().default("ACTIVE_WAITING"),
    version: integer("version").notNull().default(1),
    trueSince: timestamp("true_since", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conditional_rules_wallet_idx").on(t.walletAddress),
    index("conditional_rules_status_idx").on(t.status),
    index("conditional_rules_token_idx").on(t.tokenId),
  ],
);

export type ConditionalRuleRow = typeof conditionalRules.$inferSelect;
export type NewConditionalRuleRow = typeof conditionalRules.$inferInsert;

/**
 * Provable triggers (docs/04 §5). Append-mostly: a trigger is created when a
 * rule's continuous window completes, then advances awaiting_user → confirmed |
 * dismissed | expired. `evidence` is the self-contained TriggerEvidence;
 * `orderIntentId` links the order the user manually confirmed + signed.
 */
export const ruleTriggers = pgTable(
  "rule_triggers",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ruleId: uuid("rule_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    evidence: jsonb("evidence").notNull(),
    reasonCodes: jsonb("reason_codes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("awaiting_user"),
    orderIntentId: uuid("order_intent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rule_triggers_rule_idx").on(t.ruleId),
    index("rule_triggers_wallet_idx").on(t.walletAddress),
    index("rule_triggers_status_idx").on(t.status),
  ],
);

export type RuleTriggerRow = typeof ruleTriggers.$inferSelect;
export type NewRuleTriggerRow = typeof ruleTriggers.$inferInsert;

/**
 * Per-user Privy-managed embedded trading wallet. The raw private key NEVER
 * touches this app — Privy holds it in a secure enclave. We store only references
 * (privyWalletId is used for every signing call) plus the embedded EOA address,
 * which is the maker == signer == funder for signatureType 0 orders.
 * `policyId` is the Privy policy allowlisting only Polymarket contracts.
 * `allowancesBootstrappedAt` marks the one-time USDC/CTF approvals (Slice C) done.
 */
export const privyWallets = pgTable(
  "privy_wallets",
  {
    walletAddress: text("wallet_address").primaryKey(), // login EOA (identity)
    privyUserId: text("privy_user_id").notNull(),
    privyWalletId: text("privy_wallet_id").notNull(),
    embeddedAddress: text("embedded_address").notNull(),
    policyId: text("policy_id"),
    allowancesBootstrappedAt: timestamp("allowances_bootstrapped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("privy_wallets_embedded_idx").on(t.embeddedAddress)],
);

export type PrivyWalletRow = typeof privyWallets.$inferSelect;
export type NewPrivyWalletRow = typeof privyWallets.$inferInsert;

/**
 * Records the user's one-time consent delegating server-side signing authority to
 * the app (the "sign once" moment). Time-bounded: `expiresAt` enforces re-auth.
 * status: active → revoked | expired. This is an app-side ledger of the Privy
 * session-signer grant; Privy independently enforces policy + revocation.
 */
export const tradingDelegations = pgTable(
  "trading_delegations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    sessionSignerId: text("session_signer_id"),
    status: text("status").notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trading_delegations_wallet_idx").on(t.walletAddress),
    index("trading_delegations_status_idx").on(t.status),
    index("trading_delegations_expires_at_idx").on(t.expiresAt),
  ],
);

export type TradingDelegationRow = typeof tradingDelegations.$inferSelect;
export type NewTradingDelegationRow = typeof tradingDelegations.$inferInsert;
