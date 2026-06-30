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
  "geoblock.checked",
  "feature_flag.changed",
  "kill_switch.toggled",
  "order.intent",
  "order.signed",
  "order.submitted",
  "order.acknowledged",
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
  "admin.action",
  "trade.credentials.setup",
  "trade.order.preview",
  "trading_account.external_upserted",
  "trading_account.primary_set",
  "trading_account.archived",
  "trading_wallet.provisioned",
  "trading_wallet.deposit_wallet_activation_started",
  "trading_wallet.deposit_wallet_activation_ready",
  "trading_wallet.deposit_wallet_activation_failed",
  "trading_wallet.delegated",
  "trading_wallet.revoked",
  "allowance.approve.submitted",
  "allowance.approve.confirmed",
  "allowance.failed",
  "delegation.expired",
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
