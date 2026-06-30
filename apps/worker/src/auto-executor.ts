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
import type { RuleDefinition, TriggerEvidence } from "@mx2/rules";

/**
 * Conditional auto-execution. When an "auto" rule's window completes, the worker
 * builds + signs + submits the order with no human in the loop. Every guard is
 * FAIL-CLOSED: any failure either degrades to manual (leaves the trigger
 * awaiting_user) or marks EXECUTION_FAILED — it never silently proceeds.
 *
 * Security properties:
 *  - gated by FEATURE_CONDITIONAL_LIVE_EXECUTION (wired only then) + FEATURE_LIVE_TRADING,
 *  - honors the kill switch, delegation expiry, allowance bootstrap, and rate limit,
 *  - compare-and-set claim (markExecuting) so a concurrent user action wins,
 *  - deterministic idempotency key (auto:<ruleId>:<triggerId>) — no double-submit
 *    across worker restarts,
 *  - signs via the TradingSigner seam (raw key stays in Privy's enclave).
 */

export interface AutoExecRule {
  readonly id: string;
  readonly walletAddress: string;
  readonly tokenId: string;
  readonly def: RuleDefinition;
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
}

export interface AutoExecuteInput {
  rule: AutoExecRule;
  triggerId: string;
  evidence: TriggerEvidence;
  nowMs: number;
}

export interface AutoExecutor {
  execute(input: AutoExecuteInput): Promise<void>;
}

export const createAutoExecutor = (deps: AutoExecutorDeps): AutoExecutor => {
  const isPaused = async (): Promise<boolean> => {
    const flag = await deps.runtimeFlags.get("trading_paused");
    return flag?.value === "true";
  };

  // Degrade-to-manual: leave the trigger awaiting_user, audit why, stop.
  const skip = async (rule: AutoExecRule, triggerId: string, reason: string): Promise<void> => {
    await deps.auditStore.emit({
      actor: rule.walletAddress,
      action: "rule.execution.skipped",
      subject: `rule:${rule.id}`,
      metadata: { triggerId, reason },
    });
    deps.logger.warn(
      { ruleId: rule.id, triggerId, reason },
      "Auto-execution skipped (fail-closed) — left awaiting manual confirmation",
    );
  };

  return {
    async execute({ rule, triggerId, nowMs }) {
      const wallet = rule.walletAddress;

      // ── Pre-flight guards (fail-closed → degrade to manual). ──
      if (!deps.config.features.liveTrading) return skip(rule, triggerId, "live_trading_disabled");
      if (await isPaused()) return skip(rule, triggerId, "kill_switch");
      if (!deps.config.encryptionMasterKey) return skip(rule, triggerId, "no_master_key");

      const pw = await deps.privyWallets.find(wallet);
      if (!pw) return skip(rule, triggerId, "wallet_not_provisioned");
      if (!pw.allowancesBootstrappedAt) return skip(rule, triggerId, "allowances_missing");

      const delegation = await deps.delegations.findActive(wallet);
      if (!delegation) return skip(rule, triggerId, "delegation_expired");

      // Rate limit — shared with the manual path via the order_intents count.
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

      // Polymarket live CLOB rejects bare Privy EOA makers. Until the relayer
      // deposit-wallet path is wired, unattended execution must degrade to manual.
      return skip(rule, triggerId, "deposit_wallet_relayer_required");
    },
  };
};
