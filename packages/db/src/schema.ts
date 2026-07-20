import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
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
    // Timeline reads: events for one subject, newest first (migration 0017).
    index("audit_events_subject_created_idx").on(t.subject, t.createdAt),
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
    /**
     * NULL = full session (browser login). Non-null = restricted session minted
     * from a sign-link token or Telegram Mini App auth (migration 0018);
     * require-auth rejects these by default — only explicitly scoped routes
     * accept them. Shape: { type: "trigger", triggerId } | { type: "telegram_wallet" }.
     */
    scope: jsonb("scope"),
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
    archivedAt: timestamp("archived_at", { withTimezone: true }),
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
    // Fill reconciliation (migration 0016) — written only by the worker's
    // order-sync loop; statuses only ever advance, never regress.
    filledSize: numeric("filled_size").notNull().default("0"),
    avgFillPrice: numeric("avg_fill_price"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
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
    // Smart Order DSL v2 (migration 0009; ADR-0010). v1 rows keep defaults.
    name: text("name"),
    templateId: text("template_id"),
    /** Every tokenId the strategy reads — the worker's subscription set. */
    tokenIds: jsonb("token_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    triggerCount: integer("trigger_count").notNull().default(0),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    /**
     * Trailing-condition watermarks keyed by node id (migration 0011).
     * NULL for strategies without trailing conditions. Survives worker
     * restarts by design (D-025) — a trailing stop keeps protecting through
     * an outage; staleness rules stop it firing on bad data.
     */
    runtimeWatermarks: jsonb("runtime_watermarks"),
    totalNotionalExecuted: numeric("total_notional_executed").notNull().default("0"),
    /** Freeform organization labels (lowercased, ≤10 per strategy). */
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Reversible soft-hide for ended strategies (terminal statuses only —
     * an active strategy can never be hidden from monitoring). No hard delete.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * Stale-pause marker (migration 0019): set while the hold window is paused
     * because market data went stale; cleared on resume or reset. Persisted so
     * a worker restart mid-pause keeps honest accounting.
     */
    staleSince: timestamp("stale_since", { withTimezone: true }),
    /**
     * Versioned-edit linkage (migration 0019, D-020 stays intact): editing an
     * armed strategy creates a new row that `supersedes` the old one; the old
     * row gets `supersededBy`. Spend caps carry over on supersede.
     */
    supersedes: uuid("supersedes"),
    supersededBy: uuid("superseded_by"),
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
    /**
     * Bounded auto-retry (migration 0019): when the auto-executor skipped for a
     * recoverable reason (funds in transit, allowances pending), the sweeper may
     * re-attempt this trigger until this deadline — after re-verifying the
     * conditions fresh. NULL = no retry scheduled.
     */
    autoRetryUntil: timestamp("auto_retry_until", { withTimezone: true }),
    autoRetryReason: text("auto_retry_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rule_triggers_rule_idx").on(t.ruleId),
    index("rule_triggers_wallet_idx").on(t.walletAddress),
    index("rule_triggers_status_idx").on(t.status),
    index("rule_triggers_retry_idx")
      .on(t.status, t.autoRetryUntil)
      .where(sql`"auto_retry_until" IS NOT NULL`),
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

/**
 * One quoting session per armed quote_loop Smart Order (RFC-0003). The session
 * row is the live scoreboard (inventory, PnL, accruals) the cockpit reads;
 * every underlying event is in quote_events. mode escalates shadow → confirm →
 * live only via the audited API and only under FEATURE_MAKER_LOOP_LIVE.
 */
export const quoteSessions = pgTable(
  "quote_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ruleId: uuid("rule_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    mode: text("mode").notNull().default("shadow"), // shadow | confirm | live
    status: text("status").notNull().default("idle"), // idle | quoting | halted
    haltedReason: text("halted_reason"),
    inventoryYes: numeric("inventory_yes").notNull().default("0"),
    inventoryNo: numeric("inventory_no").notNull().default("0"),
    capitalCommittedUsd: numeric("capital_committed_usd").notNull().default("0"),
    realizedPnlUsd: numeric("realized_pnl_usd").notNull().default("0"),
    dailyLossUsd: numeric("daily_loss_usd").notNull().default("0"),
    rewardsAccruedUsd: numeric("rewards_accrued_usd").notNull().default("0"),
    lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
    /**
     * Confirm-mode batch protocol (migration 0012, RFC-0003 checkpoint 3):
     * the worker proposes {cancels, places, mergePairs} + its hash; the API
     * writes ONLY approved_batch_hash; the worker executes only when the
     * recomputed hash still matches (a moved book re-proposes — stale
     * approvals structurally cannot execute).
     */
    pendingBatch: jsonb("pending_batch"),
    pendingBatchHash: text("pending_batch_hash"),
    pendingBatchAt: timestamp("pending_batch_at", { withTimezone: true }),
    approvedBatchHash: text("approved_batch_hash"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Fill accounting cost pools (avg entry per side) + daily-loss UTC day. */
    inventoryYesCostUsd: numeric("inventory_yes_cost_usd").notNull().default("0"),
    inventoryNoCostUsd: numeric("inventory_no_cost_usd").notNull().default("0"),
    dailyLossDay: text("daily_loss_day"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quote_sessions_rule_idx").on(t.ruleId),
    index("quote_sessions_wallet_idx").on(t.walletAddress),
    index("quote_sessions_status_idx").on(t.status),
  ],
);

export type QuoteSessionRow = typeof quoteSessions.$inferSelect;
export type NewQuoteSessionRow = typeof quoteSessions.$inferInsert;

/**
 * Append-only audit-grade ledger of everything a quoting session did (or, in
 * shadow mode, WOULD have done): cycles, quote intents, placements, cancels,
 * fills, merges, halts. The UNIQUE idempotency key is the DB-level anti-replay
 * guard — a re-run cycle can never double-book an action.
 */
export const quoteEvents = pgTable(
  "quote_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key").unique(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quote_events_session_idx").on(t.sessionId),
    index("quote_events_rule_idx").on(t.ruleId),
    index("quote_events_created_at_idx").on(t.createdAt),
  ],
);

export type QuoteEventRow = typeof quoteEvents.$inferSelect;
export type NewQuoteEventRow = typeof quoteEvents.$inferInsert;

/**
 * Daily liquidity-rewards accruals polled from the authed CLOB rewards
 * endpoints (one row per wallet × market × day; upsert-once semantics).
 */
export const rewardAccruals = pgTable(
  "reward_accruals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    conditionId: text("condition_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    rewardsUsd: numeric("rewards_usd").notNull().default("0"),
    raw: jsonb("raw")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reward_accruals_wallet_market_day_unique").on(
      t.walletAddress,
      t.conditionId,
      t.day,
    ),
    index("reward_accruals_wallet_idx").on(t.walletAddress),
    index("reward_accruals_market_idx").on(t.conditionId),
  ],
);

export type RewardAccrualRow = typeof rewardAccruals.$inferSelect;
export type NewRewardAccrualRow = typeof rewardAccruals.$inferInsert;

/**
 * Owner-only trading-wallet withdrawals (migration 0012). Destination is
 * ALWAYS the session user's login wallet, resolved server-side — never client
 * input. The (wallet, idempotency key) unique index is the double-submit
 * guard; audit events mirror every state change.
 */
export const walletWithdrawals = pgTable(
  "wallet_withdrawals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    depositWalletAddress: text("deposit_wallet_address").notNull(),
    destinationAddress: text("destination_address").notNull(),
    amountUsd: numeric("amount_usd").notNull(),
    state: text("state").notNull().default("requested"), // requested | submitted | confirmed | failed
    relayerTransactionId: text("relayer_transaction_id"),
    transactionHash: text("transaction_hash"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_withdrawals_idem_unique").on(t.walletAddress, t.idempotencyKey),
    index("wallet_withdrawals_wallet_idx").on(t.walletAddress),
  ],
);

export type WalletWithdrawalRow = typeof walletWithdrawals.$inferSelect;
export type NewWalletWithdrawalRow = typeof walletWithdrawals.$inferInsert;

/**
 * Persisted Polymarket Bridge addresses (migration 0014). One row per
 * generated address per user: deposit hops (kind=deposit, per address family)
 * and withdrawal hops (kind=withdrawal, per destination route). Persisting
 * them lets the sheet reuse addresses instead of regenerating per open, and
 * gives the status poller its work list.
 */
export const bridgeAddresses = pgTable(
  "bridge_addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    depositWalletAddress: text("deposit_wallet_address").notNull(),
    kind: text("kind").notNull().default("deposit"),
    addressType: text("address_type").notNull(),
    address: text("address").notNull(),
    /** Withdrawal hops only: the destination route baked into the address. */
    toChainId: text("to_chain_id"),
    toTokenAddress: text("to_token_address"),
    recipientAddress: text("recipient_address"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bridge_addresses_wallet_addr_unique").on(t.walletAddress, t.kind, t.address),
    index("bridge_addresses_wallet_idx").on(t.walletAddress),
  ],
);

export type BridgeAddressRow = typeof bridgeAddresses.$inferSelect;
export type NewBridgeAddressRow = typeof bridgeAddresses.$inferInsert;

/**
 * Bridge deposit transfers, upserted from the provider status API.
 * State machine (never regresses; completed/failed terminal):
 * detected → processing → origin_confirmed → submitted → completed | failed.
 * providerStatus is stored verbatim; unknown provider statuses bucket into
 * "processing" without failing.
 */
export const bridgeDeposits = pgTable(
  "bridge_deposits",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    bridgeAddressId: uuid("bridge_address_id").notNull(),
    fromChainId: text("from_chain_id").notNull().default(""),
    fromTokenAddress: text("from_token_address").notNull().default(""),
    fromAmountBaseUnit: text("from_amount_base_unit").notNull().default(""),
    state: text("state").notNull().default("detected"),
    providerStatus: text("provider_status").notNull().default(""),
    txHash: text("tx_hash"),
    providerCreatedTimeMs: bigint("provider_created_time_ms", { mode: "number" })
      .notNull()
      .default(0),
    /** Set when this row was retired in favor of another row for the same transfer. */
    supersededByDepositId: uuid("superseded_by_deposit_id"),
    /** User pressed Dismiss on a stuck record — hidden from active surfaces, kept in history. */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** How the row reached `completed`: "provider" (normal) or "chain_reconciled". */
    completionSource: text("completion_source"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bridge_deposits_dedupe_unique").on(
      t.bridgeAddressId,
      t.fromChainId,
      t.fromTokenAddress,
      t.fromAmountBaseUnit,
      t.providerCreatedTimeMs,
    ),
    index("bridge_deposits_wallet_idx").on(t.walletAddress),
  ],
);

export type BridgeDepositRow = typeof bridgeDeposits.$inferSelect;
export type NewBridgeDepositRow = typeof bridgeDeposits.$inferInsert;

/**
 * Two-leg bridge withdrawals (deposit wallet → bridge address on Polygon →
 * destination chain). Destination is ALWAYS the user's own login wallet,
 * resolved server-side (D-026). State machine:
 * requested → address_created → polygon_submitted → polygon_confirmed →
 * bridging → completed, with failed_address | failed_polygon (recoverable —
 * funds never left) and failed_bridge (support/recovery flow) offshoots.
 */
export const bridgeWithdrawals = pgTable(
  "bridge_withdrawals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    depositWalletAddress: text("deposit_wallet_address").notNull(),
    destinationAddress: text("destination_address").notNull(),
    toChainId: text("to_chain_id").notNull(),
    toTokenAddress: text("to_token_address").notNull(),
    bridgeAddressId: uuid("bridge_address_id"),
    amountUsd: numeric("amount_usd").notNull(),
    quoteId: text("quote_id"),
    estToTokenBaseUnit: text("est_to_token_base_unit"),
    state: text("state").notNull().default("requested"),
    relayerTransactionId: text("relayer_transaction_id"),
    polygonTxHash: text("polygon_tx_hash"),
    bridgeTxHash: text("bridge_tx_hash"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bridge_withdrawals_idem_unique").on(t.walletAddress, t.idempotencyKey),
    index("bridge_withdrawals_wallet_idx").on(t.walletAddress),
  ],
);

export type BridgeWithdrawalRow = typeof bridgeWithdrawals.$inferSelect;
export type NewBridgeWithdrawalRow = typeof bridgeWithdrawals.$inferInsert;

/**
 * Server-synced builder drafts (migration 0015, ADR-0019). Free-form
 * StrategyDoc JSON + per-draft AI chat, keyed by the client's draft id.
 * Last-write-wins on updatedAtClient (client-side ms) — a deliberate
 * single-user tradeoff. Deliberately NOT conditional_rules: drafts mutate per
 * keystroke and may not compile; armed definitions are immutable (D-020).
 */
export const strategyDrafts = pgTable(
  "strategy_drafts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    clientDraftId: text("client_draft_id").notNull(),
    name: text("name").notNull().default(""),
    origin: text("origin").notNull().default("blank"),
    doc: jsonb("doc").notNull(),
    aiMessages: jsonb("ai_messages")
      .notNull()
      .default(sql`'[]'::jsonb`),
    aiHistory: jsonb("ai_history")
      .notNull()
      .default(sql`'[]'::jsonb`),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    schemaVersion: integer("schema_version").notNull().default(1),
    status: text("status").notNull().default("active"),
    armedRuleId: uuid("armed_rule_id"),
    updatedAtClient: bigint("updated_at_client", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("strategy_drafts_wallet_client_unique").on(t.walletAddress, t.clientDraftId),
    index("strategy_drafts_wallet_idx").on(t.walletAddress),
  ],
);

export type StrategyDraftRow = typeof strategyDrafts.$inferSelect;
export type NewStrategyDraftRow = typeof strategyDrafts.$inferInsert;

/**
 * External notification channels (migration 0018). One row per linked
 * Telegram chat / Discord user per login wallet. Linking always goes through a
 * single-use channel_link_codes code minted by the authenticated wallet, so an
 * external account can never attach itself to a wallet it doesn't control.
 * `preferences` holds per-kind opt-outs; a kind absent from the map is ON.
 */
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    channel: text("channel").notNull(), // telegram | discord
    /** Telegram chat id / Discord user id. */
    externalId: text("external_id").notNull(),
    externalUsername: text("external_username"),
    status: text("status").notNull().default("active"), // active | revoked
    preferences: jsonb("preferences")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_channels_wallet_idx").on(t.walletAddress),
    // Bot-side lookup: which wallet does this chat belong to?
    index("notification_channels_external_idx").on(t.channel, t.externalId),
    // One ACTIVE link per external account per channel (revoked rows are history).
    uniqueIndex("notification_channels_active_external_unique")
      .on(t.channel, t.externalId)
      .where(sql`status = 'active'`),
  ],
);

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;
export type NewNotificationChannelRow = typeof notificationChannels.$inferInsert;

/**
 * Single-use channel-linking codes (migration 0018). The code itself only ever
 * lives in the t.me deep link / user's DM; the DB stores SHA256(code). 10-min
 * TTL, consumed at most once (atomic UPDATE ... WHERE used_at IS NULL).
 */
export const channelLinkCodes = pgTable(
  "channel_link_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    codeHash: text("code_hash").notNull().unique(),
    walletAddress: text("wallet_address").notNull(),
    channel: text("channel").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channel_link_codes_wallet_idx").on(t.walletAddress)],
);

export type ChannelLinkCodeRow = typeof channelLinkCodes.$inferSelect;

/**
 * Transactional outbox for external notifications (migration 0018). Producers
 * (rule evaluator, auto-executor, order-sync, bridge poller) enqueue with an
 * idempotent dedupe_key; the worker dispatcher is the single consumer and
 * advances status pending → sent | skipped | failed (terminal after max
 * attempts) with exponential backoff via next_attempt_at.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletAddress: text("wallet_address").notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("notification_outbox_wallet_idx").on(t.walletAddress),
  ],
);

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutboxRow = typeof notificationOutbox.$inferInsert;

/**
 * Single-use sign-link tokens (migration 0018). Minted by the dispatcher when
 * an order-awaiting-signature notification is sent; the raw token only lives in
 * the message URL, the DB stores SHA256(token). Exchanging one yields a
 * trigger-scoped session (sessions.scope) — it can view exactly one prepared
 * order; executing still requires the main-wallet EIP-712 signature.
 */
export const signLinkTokens = pgTable(
  "sign_link_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tokenHash: text("token_hash").notNull().unique(),
    walletAddress: text("wallet_address").notNull(),
    triggerId: uuid("trigger_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sign_link_tokens_trigger_idx").on(t.triggerId)],
);

export type SignLinkTokenRow = typeof signLinkTokens.$inferSelect;
