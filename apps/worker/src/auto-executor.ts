import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import { decryptCredentials } from "@mx2/core";
import type {
  AuditStore,
  RuleStore,
  TriggerStore,
  OrderIntentStore,
  ClobCredentialStore,
  PrivyWalletStore,
  DelegationStore,
  RuntimeFlagStore,
  EncryptedCreds,
} from "@mx2/db";
import type { AuthenticatedClobClient, L2Credentials } from "@mx2/polymarket-client";
import { buildAndSignEoaOrder } from "@mx2/polymarket-client";
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

  const fail = async (rule: AutoExecRule, triggerId: string, reason: string): Promise<void> => {
    await deps.ruleStore.markExecutionFailed(rule.id, reason);
    await deps.auditStore.emit({
      actor: rule.walletAddress,
      action: "rule.execution.failed",
      subject: `rule:${rule.id}`,
      metadata: { triggerId, reason },
    });
    deps.logger.warn({ ruleId: rule.id, triggerId, reason }, "Auto-execution failed");
  };

  return {
    async execute({ rule, triggerId, nowMs }) {
      const wallet = rule.walletAddress;
      const action = rule.def.action;

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

      // ── Claim for execution (CAS; a concurrent confirm/cancel wins). ──
      const claimed = await deps.ruleStore.markExecuting(rule.id);
      if (!claimed) return skip(rule, triggerId, "cas_lost");

      // Idempotency: deterministic key prevents double-submit across restarts.
      const idempotencyKey = `auto:${rule.id}:${triggerId}`;
      const existing = await deps.orderIntents.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        await deps.ruleStore.markAutoExecuted(rule.id);
        return;
      }

      const credsRow = await deps.clobCredentials.find(wallet);
      if (!credsRow) return fail(rule, triggerId, "clob_credentials_missing");
      let creds: L2Credentials;
      try {
        creds = decryptCredentials<L2Credentials>(
          credsRow.encryptedCreds as EncryptedCreds,
          deps.config.encryptionMasterKey,
        );
      } catch {
        return fail(rule, triggerId, "creds_decrypt_failed");
      }

      // ── Build + sign (signatureType 0) via the seam. ──
      const built = await buildAndSignEoaOrder(
        {
          tokenId: rule.tokenId,
          side: action.side,
          price: String(action.price),
          size: String(action.size),
          address: pw.embeddedAddress,
          chainId: deps.config.polymarket.chainId,
          negRisk: rule.def.negRisk ?? false,
          ...(rule.def.tickSize !== undefined ? { tickSize: rule.def.tickSize } : {}),
          builderCode: deps.config.polymarket.builderCode ?? null,
        },
        (typedData) =>
          deps.tradingSigner.signOrder({
            wallet: { walletId: pw.privyWalletId, address: pw.embeddedAddress },
            typedData,
          }),
      );
      if (!built.ok) return fail(rule, triggerId, `sign_failed:${built.error.code}`);

      // ── Record intent (idempotent) then submit. ──
      const intent = await deps.orderIntents.create({
        walletAddress: wallet,
        idempotencyKey,
        conditionId: rule.def.conditionId,
        tokenId: rule.tokenId,
        side: action.side,
        price: String(action.price),
        size: String(action.size),
        orderType: action.orderType,
        funder: pw.embeddedAddress,
        metadata: { auto: true, ruleId: rule.id, triggerId },
      });
      await deps.auditStore.emit({
        actor: wallet,
        action: "order.intent",
        subject: `intent:${intent.id}`,
        metadata: {
          auto: true,
          ruleId: rule.id,
          tokenId: rule.tokenId,
          side: action.side,
          price: String(action.price),
          size: String(action.size),
        },
      });

      const submit = await deps.tradingClobClient.submitOrder(
        built.value,
        action.orderType,
        creds,
        // built.value.maker is the checksummed embedded address (POLY_ADDRESS).
        built.value.maker as `0x${string}`,
        idempotencyKey,
      );
      if (!submit.ok) {
        await deps.orderIntents.updateStatus(intent.id, "failed", {
          errorMessage: submit.error.message,
        });
        await deps.auditStore.emit({
          actor: wallet,
          action: "order.failed",
          subject: `intent:${intent.id}`,
          metadata: { error: submit.error.code, message: submit.error.message },
        });
        return fail(rule, triggerId, "submit_failed");
      }

      await deps.orderIntents.updateStatus(intent.id, "submitted", {
        clobOrderId: submit.value.orderID,
      });
      await deps.triggerStore.updateStatus(triggerId, "confirmed", { orderIntentId: intent.id });
      await deps.ruleStore.markAutoExecuted(rule.id);
      await deps.auditStore.emit({
        actor: wallet,
        action: "order.submitted",
        subject: `intent:${intent.id}`,
        metadata: { clobOrderId: submit.value.orderID, auto: true },
      });
      await deps.auditStore.emit({
        actor: wallet,
        action: "rule.executed_auto",
        subject: `rule:${rule.id}`,
        metadata: { triggerId, orderIntentId: intent.id, clobOrderId: submit.value.orderID },
      });
      deps.logger.info(
        { ruleId: rule.id, triggerId, clobOrderId: submit.value.orderID },
        "Conditional rule auto-executed",
      );
    },
  };
};
