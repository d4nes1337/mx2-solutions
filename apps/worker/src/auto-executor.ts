import type { AppConfig } from "@mx2/config";
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  NotificationOutboxStore,
  RuleStore,
  TriggerStore,
  OrderIntentStore,
  ClobCredentialStore,
  PrivyWalletStore,
  DelegationStore,
  RuntimeFlagStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import { decryptCredentials } from "@mx2/core";
import { submit1271Order, type L2Credentials } from "@mx2/polymarket-client";
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
 *  9. deposit-wallet account + decryptable CLOB credentials (W4 prerequisites)
 * 10. balance pre-check (deposit-wallet pUSD must cover the order)
 * 11. build + POLY_1271-sign + submit via the shared submit1271Order path
 *     (maker = signer = funder = deposit wallet, sigType 3 — INTEGRATION §12a)
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
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  tradingClobClient: AuthenticatedClobClient;
  ruleStore: RuleStore;
  triggerStore: TriggerStore;
  auditStore: AuditStore;
  /**
   * On-chain collateral balance reader in USD (null when no Polygon RPC is
   * configured). W4: reads the deposit wallet's pUSD (INTEGRATION §23).
   */
  balanceOfUsdc?: ((owner: string) => Promise<number>) | null;
  /** Notification outbox (FEATURE_NOTIFICATIONS): informational "auto-executed"
   * messages — deliberately without a sign link (nothing left to sign). */
  outbox?: NotificationOutboxStore;
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
      const masterKey = deps.config.encryptionMasterKey;
      if (!masterKey) return skip(rule, triggerId, "no_master_key");
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

      // ── 9. Deposit-wallet account + CLOB credentials (W4 prerequisites). ──
      // Fail-closed skip reasons are surfaced to the user via the audit trail.
      if (!deps.config.features.privySigning) {
        return skip(rule, triggerId, "privy_signing_disabled");
      }
      const accounts = await deps.tradingAccounts.listByOwner(wallet);
      const account = accounts.find(
        (a) =>
          a.kind === "internal_privy" &&
          a.archivedAt === null &&
          a.privyWalletId !== null &&
          a.depositWalletAddress !== null &&
          a.signerAddress.toLowerCase() === pw.embeddedAddress.toLowerCase(),
      );
      if (!account?.depositWalletAddress || !account.privyWalletId) {
        return skip(rule, triggerId, "deposit_wallet_required");
      }
      const credsRow = await deps.accountClobCredentials.find(account.id);
      if (!credsRow) return skip(rule, triggerId, "clob_credentials_missing");
      let creds: L2Credentials;
      try {
        creds = decryptCredentials<L2Credentials>(
          credsRow.encryptedCreds as Parameters<typeof decryptCredentials>[0],
          masterKey,
        );
      } catch (e) {
        return skip(rule, triggerId, "clob_credentials_unreadable", {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // ── 10. Balance pre-check: the DEPOSIT wallet's pUSD must cover the
      // order (deposit wallets hold pUSD — INTEGRATION §23). ──
      if (deps.balanceOfUsdc) {
        try {
          const balance = await deps.balanceOfUsdc(account.depositWalletAddress);
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

      // ── 11. Build + POLY_1271-sign + submit (W4, shared path with the
      // manual route). Deterministic idempotency key — restart-safe. ──
      const idempotencyKey = `auto:${rule.id}:${triggerId}`;
      const existingIntent = await deps.orderIntents.findByIdempotencyKey(idempotencyKey);
      if (existingIntent) {
        deps.logger.info(
          { ruleId: rule.id, triggerId, intentId: existingIntent.id },
          "Auto-execution intent already exists — not re-submitting",
        );
        return;
      }

      // Once-rules: claim the rule via compare-and-set before committing
      // funds. If the user confirmed/dismissed concurrently, the CAS loses and
      // the user's action wins. Repeat rules stay ACTIVE between repetitions —
      // no rule-status claim applies (the trigger row is the unit of work).
      const isOnce = rule.def.recurrence.kind === "once";
      if (isOnce) {
        const claimed = await deps.ruleStore.markExecuting(rule.id);
        if (!claimed) return skip(rule, triggerId, "rule_claim_lost");
      }

      const intent = await deps.orderIntents.create({
        walletAddress: wallet,
        tradingAccountId: account.id,
        idempotencyKey,
        conditionId: action.market.conditionId,
        tokenId: action.market.tokenId || rule.tokenId,
        side: action.side,
        price: String(action.price),
        size: String(action.size),
        orderType: action.orderType,
        funder: account.depositWalletAddress,
        signer: account.signerAddress,
        signatureType: 3,
        signingMode: "server",
        metadata: { ruleId: rule.id, triggerId, auto: true },
      });
      await deps.auditStore.emit({
        actor: wallet,
        action: "order.intent",
        subject: `intent:${intent.id}`,
        metadata: {
          ruleId: rule.id,
          triggerId,
          tokenId: action.market.tokenId || rule.tokenId,
          side: action.side,
          price: action.price,
          size: action.size,
          orderType: action.orderType,
          funder: account.depositWalletAddress,
          auto: true,
        },
      });

      const walletRef = { walletId: account.privyWalletId, address: account.signerAddress };
      const submitResult = await submit1271Order(deps.tradingClobClient, {
        signerAddress: account.signerAddress,
        depositWalletAddress: account.depositWalletAddress,
        sign: async (payload) => {
          const r = await deps.tradingSigner.signOrder({ wallet: walletRef, typedData: payload });
          if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
          return r.value.signature;
        },
        params: {
          tokenId: action.market.tokenId || rule.tokenId,
          side: action.side,
          price: action.price,
          size: action.size,
          tickSize: action.tickSize ?? "0.01",
          negRisk: action.negRisk ?? false,
          orderType: action.orderType,
          ...(action.postOnly !== undefined ? { postOnly: action.postOnly } : {}),
          ...(action.orderType === "GTD" && action.expiresAfterMs !== undefined
            ? // Wire expiration compensates Polymarket's ~1-min early expiry (ADR-0013).
              { expiresAtSec: Math.floor((nowMs + action.expiresAfterMs) / 1000) + 60 }
            : {}),
        },
        creds,
        idempotencyKey,
      });

      if (!submitResult.ok) {
        // Fail closed: a submit error after signing may still have registered
        // upstream — never degrade to manual re-submission. The intent is
        // failed, once-rules go terminal EXECUTION_FAILED, everything audited.
        await deps.orderIntents.updateStatus(intent.id, "failed", {
          errorMessage: submitResult.error.message,
        });
        if (isOnce) await deps.ruleStore.markExecutionFailed(rule.id, submitResult.error.message);
        await deps.auditStore.emit({
          actor: wallet,
          action: "rule.execution.failed",
          subject: `rule:${rule.id}`,
          metadata: {
            triggerId,
            intentId: intent.id,
            error: submitResult.error.code,
            message: submitResult.error.message,
          },
        });
        deps.logger.warn(
          { ruleId: rule.id, triggerId, intentId: intent.id, error: submitResult.error },
          "Auto-execution order submit failed",
        );
        return;
      }

      const clobOrderId = submitResult.value.ack.orderID;
      await deps.orderIntents.updateStatus(intent.id, "submitted", { clobOrderId });
      await deps.ruleStore.addExecutedNotional(rule.id, orderNotional);
      await deps.triggerStore.updateStatus(triggerId, "confirmed", { orderIntentId: intent.id });
      if (isOnce) await deps.ruleStore.markAutoExecuted(rule.id);
      await deps.auditStore.emit({
        actor: wallet,
        action: "order.submitted",
        subject: `intent:${intent.id}`,
        metadata: { clobOrderId, status: submitResult.value.ack.status, auto: true },
      });
      await deps.auditStore.emit({
        actor: wallet,
        action: "rule.executed_auto",
        subject: `rule:${rule.id}`,
        metadata: {
          triggerId,
          intentId: intent.id,
          clobOrderId,
          orderNotional,
          tokenId: action.market.tokenId || rule.tokenId,
          side: action.side,
          price: action.price,
          size: action.size,
        },
      });
      deps.logger.info(
        { ruleId: rule.id, triggerId, intentId: intent.id, clobOrderId },
        "Auto-execution order submitted (POLY_1271 deposit-wallet path)",
      );
      if (deps.outbox) {
        await deps.outbox
          .enqueue({
            walletAddress: wallet,
            kind: "order_auto_executed",
            dedupeKey: `trigger:${triggerId}:auto`,
            payload: {
              triggerId,
              ruleId: rule.id,
              ruleName: null,
              side: action.side,
              price: action.price,
              size: action.size,
              orderType: action.orderType,
              intentId: intent.id,
            },
          })
          .catch((e: unknown) =>
            deps.logger.warn({ err: e, triggerId }, "auto-exec notification enqueue failed"),
          );
      }
    },
  };
};
