/**
 * Append-only audit event domain types. Audit events are immutable: never
 * updated or deleted. They form the backbone of the trading/conditional-rule
 * trust chain (intent -> signature -> submission -> ack -> fill/cancel) and of
 * security-relevant actions (auth, allowlist, kill switch, admin).
 */
export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.wallet_linked",
  "allowlist.checked",
  "allowlist.auto_added",
  "geoblock.checked",
  "feature_flag.changed",
  "kill_switch.toggled",
  "order.intent",
  "order.signed",
  "order.submitted",
  "order.acknowledged",
  "order.partially_filled",
  "order.filled",
  "order.cancelled",
  "order.cancel_failed",
  "order.failed",
  "order.rate_limited",
  "rule.created",
  "rule.state_changed",
  "rule.triggered",
  "rule.trigger.confirmed",
  "rule.trigger.dismissed",
  "rule.executed_auto",
  "rule.execution.failed",
  "rule.execution.skipped",
  // Crash-recovery + bounded funds-arrival retry (migration 0019):
  "rule.execution.recovered",
  "rule.execution.retry_scheduled",
  "rule.execution.retried",
  "rule.execution.retry_abandoned",
  "ai.strategy_generated",
  "quoter.session_started",
  "quoter.halted",
  "quoter.resumed",
  "quoter.mode_changed",
  "quoter.batch_approved",
  "quoter.merge_submitted",
  "admin.action",
  "trade.credentials.setup",
  "trade.order.preview",
  "trading_account.external_upserted",
  "trading_account.primary_set",
  "trading_account.archived",
  "trading_account.unarchived",
  "wallet.withdraw.requested",
  "wallet.withdraw.submitted",
  "wallet.withdraw.failed",
  "wallet.bridge.deposit_addresses_requested",
  "wallet.bridge.deposit_state_changed",
  "wallet.bridge.withdraw_requested",
  "wallet.bridge.withdraw_address_created",
  "wallet.bridge.withdraw_submitted",
  "wallet.bridge.withdraw_state_changed",
  "wallet.bridge.withdraw_failed",
  "wallet.bridge.reconciliation_flagged",
  /** User hid a stuck transfer record from active surfaces (0019). */
  "wallet.bridge.deposit_dismissed",
  "trading_wallet.provisioned",
  "trading_wallet.ghost_detected",
  "trading_wallet.reissued",
  "trading_wallet.deposit_wallet_activation_started",
  "trading_wallet.deposit_wallet_activation_ready",
  "trading_wallet.deposit_wallet_activation_failed",
  "trading_wallet.delegated",
  "trading_wallet.revoked",
  "allowance.approve.submitted",
  "allowance.approve.confirmed",
  "allowance.failed",
  "delegation.expired",
  "delegation.expiring",
  "notification.channel_link_requested",
  "notification.channel_linked",
  "notification.channel_unlinked",
  "notification.preferences_updated",
  "notification.sent",
  "notification.send_failed",
  "auth.scoped_session_created",
  "system.startup",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  readonly id: string;
  /** Wallet address or "system"/"admin:<id>"; never a private key. */
  readonly actor: string;
  readonly action: AuditAction;
  /** Stable reference to the affected entity, e.g. "order:<id>", "rule:<id>". */
  readonly subject: string | null;
  /** Non-sensitive structured context. Must never contain secrets. */
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

/** Input shape for emitting a new audit event (id/createdAt assigned by store). */
export type NewAuditEvent = Omit<AuditEvent, "id" | "createdAt">;
