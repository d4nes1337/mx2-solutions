import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  RuleStore,
  TriggerStore,
  OrderIntentStore,
  ClobCredentialStore,
  PrivyWalletStore,
  DelegationStore,
  RuntimeFlagStore,
} from "@mx2/db";
import type { AuthenticatedClobClient } from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";
import type { StrategyDefinition, TriggerEvidence, TriggerEvidenceV2 } from "@mx2/rules";

/**
 * Conditional auto-execution. When an "auto" strategy's window completes, the
 * worker builds + signs + submits the order with no human in the loop. Every
 * guard is FAIL-CLOSED: any failure either degrades to manual (leaves the
 * trigger awaiting_user) or marks EXECUTION_FAILED — it never silently proceeds.
 *
 * Guard chain (ADR-0010 / W5–W8), in order:
 *  1. FEATURE_LIVE_TRADING + (wired only under FEATURE_CONDITIONAL_LIVE_EXECUTION)
 *  2. global kill switch (runtime flag `trading_paused`)
 *  3. per-strategy kill (runtime flag `rule_auto_disabled:<id>`)
 *  4. encryption master key present
 *  5. wallet provisioned + allowances bootstrapped
 *  6. active delegation (with a `delegation.expiring` audit inside 48 h)
 *  7. global order rate limit (shared with the manual path)
 *  8. per-strategy limits — REQUIRED for auto:
 *       per-order cap, daily notional (Σ auto intents since UTC midnight),
 *       lifetime total (conditional_rules.total_notional_executed),
 *       repeat count (evidence.triggerNumber vs maxRepeats — belt+braces,
 *       the state machine already enforces it)
 *  9. balance pre-check (deposit-wallet USDC must cover the order)
 * 10. relayer order path (W4 — still pending; hard skip until wired)
 *
 * Idempotency: deterministic key `auto:<ruleId>:<triggerId>` — no double-submit
 * across worker restarts. Signing goes through the TradingSigner seam (the raw
 * key stays in Privy's enclave).
 */

export interface AutoExecRule {
  readonly id: string;
  readonly walletAddress: string;
  readonly tokenId: string;
  /** Normalized v2 definition (v1 rules arrive through normalizeDefinition). */
  readonly def: StrategyDefinition;
}

export interface AutoExecutorDeps {
  logger: Logger;
  config: AppConfig;
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  delegations: DelegationStore;
  runtimeFlags: RuntimeFlagStore;
  orderIntents: OrderIntentStore;
  clobCredentials: ClobCredentialStore;
  tradingClobClient: AuthenticatedClobClient;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  auditStore: AuditStore;
  /** On-chain USDC balance reader (null when no Polygon RPC is configured). */
  balanceOfUsdc?: ((owner: string) => Promise<number>) | null;
}

export interface AutoExecuteInput {
  rule: AutoExecRule;
  triggerId: string;
  evidence: TriggerEvidence | TriggerEvidenceV2;
  nowMs: number;
}

export interface AutoExecutor {
  execute(input: AutoExecuteInput): Promise<void>;
}

const DELEGATION_EXPIRY_WARNING_MS = 48 * 3_600_000;

const utcMidnight = (nowMs: number): Date => {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export const createAutoExecutor = (deps: AutoExecutorDeps): AutoExecutor => {
  const flagIsTrue = async (key: string): Promise<boolean> => {
    const flag = await deps.runtimeFlags.get(key);
    return flag?.value === "true";
  };

  // Degrade-to-manual: leave the trigger awaiting_user, audit why, stop.
  const skip = async (
    rule: AutoExecRule,
    triggerId: string,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await deps.auditStore.emit({
      actor: rule.walletAddress,
      action: "rule.execution.skipped",
      subject: `rule:${rule.id}`,
      metadata: { triggerId, reason, ...metadata },
    });
    deps.logger.warn(
      { ruleId: rule.id, triggerId, reason },
      "Auto-execution skipped (fail-closed) — left awaiting manual confirmation",
    );
  };

  return {
    async execute({ rule, triggerId, evidence, nowMs }) {
      const wallet = rule.walletAddress;

      // ── 1–2. Feature flag + global kill switch. ──
      if (!deps.config.features.liveTrading) return skip(rule, triggerId, "live_trading_disabled");
      if (await flagIsTrue("trading_paused")) return skip(rule, triggerId, "kill_switch");

      // ── 3. Per-strategy kill (user disarm / admin). ──
      if (await flagIsTrue(`rule_auto_disabled:${rule.id}`)) {
        return skip(rule, triggerId, "auto_disabled");
      }

      // ── 4–5. Master key + wallet readiness. ──
      if (!deps.config.encryptionMasterKey) return skip(rule, triggerId, "no_master_key");
      const pw = await deps.privyWallets.find(wallet);
      if (!pw) return skip(rule, triggerId, "wallet_not_provisioned");
      if (!pw.allowancesBootstrappedAt) return skip(rule, triggerId, "allowances_missing");

      // ── 6. Delegation (+ expiring-soon alert seam). ──
      const delegation = await deps.delegations.findActive(wallet);
      if (!delegation) return skip(rule, triggerId, "delegation_expired");
      const msLeft = delegation.expiresAt.getTime() - nowMs;
      if (msLeft < DELEGATION_EXPIRY_WARNING_MS) {
        await deps.auditStore.emit({
          actor: wallet,
          action: "delegation.expiring",
          subject: `wallet:${wallet}`,
          metadata: { ruleId: rule.id, expiresAt: delegation.expiresAt.toISOString() },
        });
      }

      // ── 7. Global rate limit — shared with the manual path. ──
      const recent = await deps.orderIntents.countRecentByWallet(wallet, new Date(nowMs - 60_000));
      if (recent >= deps.config.limits.orderRateLimitPerMin) {
        await deps.auditStore.emit({
          actor: wallet,
          action: "order.rate_limited",
          subject: `rule:${rule.id}`,
          metadata: { triggerId, recent, limit: deps.config.limits.orderRateLimitPerMin },
        });
        return skip(rule, triggerId, "rate_limited");
      }

      // ── 8. Per-strategy limits (required for auto — no limits, no execution). ──
      const action = rule.def.action;
      if (action.kind !== "order" || action.execution !== "auto") {
        return skip(rule, triggerId, "not_auto_action");
      }
      const limits = rule.def.limits;
      if (!limits) return skip(rule, triggerId, "limits_missing");

      const orderNotional = action.price * action.size;
      if (orderNotional > limits.maxNotionalPerOrder) {
        return skip(rule, triggerId, "per_order_cap_exceeded", {
          orderNotional,
          maxNotionalPerOrder: limits.maxNotionalPerOrder,
        });
      }

      const triggerNumber = "triggerNumber" in evidence ? evidence.triggerNumber : 1;
      const maxRepeats = rule.def.recurrence.kind === "repeat" ? rule.def.recurrence.maxRepeats : 1;
      if (triggerNumber > maxRepeats) {
        return skip(rule, triggerId, "repeat_limit_exceeded", { triggerNumber, maxRepeats });
      }

      const executedToday = await deps.orderIntents.sumRuleAutoNotional(
        rule.id,
        utcMidnight(nowMs),
      );
      if (executedToday + orderNotional > limits.maxDailyNotional) {
        return skip(rule, triggerId, "daily_cap_exceeded", {
          executedToday,
          orderNotional,
          maxDailyNotional: limits.maxDailyNotional,
        });
      }

      const row = await deps.ruleStore.findById(rule.id);
      const lifetime = Number(row?.totalNotionalExecuted ?? 0);
      if (lifetime + orderNotional > limits.maxTotalNotional) {
        return skip(rule, triggerId, "total_cap_exceeded", {
          lifetime,
          orderNotional,
          maxTotalNotional: limits.maxTotalNotional,
        });
      }

      // ── 9. Balance pre-check: the funding wallet must cover the order. ──
      if (deps.balanceOfUsdc) {
        const account = row; // funding address comes from the trading account (W4);
        void account; //        until then, check the deposit wallet when known.
        try {
          const funder = pw.embeddedAddress; // W4 will switch this to the deposit wallet
          const balance = await deps.balanceOfUsdc(funder);
          if (balance < orderNotional) {
            return skip(rule, triggerId, "insufficient_balance", {
              balance,
              orderNotional,
            });
          }
        } catch (e) {
          return skip(rule, triggerId, "balance_check_failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // ── 10. Relayer order path (W4). Polymarket live CLOB rejects bare Privy
      // EOA makers; until the deposit-wallet relayer submit is wired and
      // staging-verified, unattended execution degrades to manual. ──
      return skip(rule, triggerId, "deposit_wallet_relayer_required");
    },
  };
};
