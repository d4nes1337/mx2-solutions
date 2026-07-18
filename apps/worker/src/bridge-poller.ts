import type { Logger } from "@mx2/observability";
import type { AuditStore, BridgeStore } from "@mx2/db";
import type { BridgeClient } from "@mx2/polymarket-client";

/**
 * Bridge deposit status poller (ADR-0017 follow-through). Every tick it takes
 * the least-recently-checked bridge addresses and pulls the provider status
 * API, upserting deposit rows through the state-machine-guarded store (states
 * never regress; every transition is audited). Read-only against the Bridge;
 * failures are logged and retried next tick, never fatal.
 *
 * Reconciliation: deposits stuck non-terminal past RECONCILE_AFTER_MS are
 * flagged once per poller lifetime with an audit event for the admin surface.
 */

export interface BridgePollerDeps {
  logger: Logger;
  bridgeStore: BridgeStore;
  bridgeClient: BridgeClient;
  auditStore: AuditStore;
  intervalMs?: number;
  /** Re-check an address at most this often. */
  staleAfterMs?: number;
  /** Addresses polled per tick (Bridge traffic bound). */
  batchSize?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;
/** Deposits non-terminal for longer than this get a reconciliation flag (2h). */
const RECONCILE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface BridgePoller {
  start(): void;
  stop(): void;
  /** One poll pass — exposed for tests. */
  tick(): Promise<void>;
}

export const createBridgePoller = (deps: BridgePollerDeps): BridgePoller => {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const reconciled = new Set<string>();

  const tick = async (): Promise<void> => {
    if (inFlight) return; // never overlap ticks
    inFlight = true;
    try {
      const addresses = await deps.bridgeStore.listPollableAddresses(
        new Date(Date.now() - staleAfterMs),
        batchSize,
      );
      for (const address of addresses) {
        const status = await deps.bridgeClient.getStatus(address.address);
        await deps.bridgeStore.markAddressChecked(address.id);
        if (!status.ok) {
          deps.logger.warn(
            { address: address.address, error: status.error.code },
            "bridge status poll failed",
          );
          continue;
        }
        // Withdrawal hop addresses track the bridge leg of a withdrawal
        // instead of inbound deposits.
        if (address.kind === "withdrawal") {
          const { changed } = await deps.bridgeStore.updateWithdrawalsFromStatus(
            address,
            status.value.transactions.map((tx) => ({ status: tx.status, txHash: tx.txHash })),
          );
          for (const change of changed) {
            await deps.auditStore.emit({
              actor: "system",
              action: "wallet.bridge.withdraw_state_changed",
              subject: `bridge_withdrawal:${change.row.id}`,
              metadata: { from: change.previousState, to: change.row.state },
            });
          }
          continue;
        }

        const { changed } = await deps.bridgeStore.upsertDepositsFromStatus(
          address,
          status.value.transactions.map((tx) => ({
            fromChainId: tx.fromChainId,
            fromTokenAddress: tx.fromTokenAddress,
            fromAmountBaseUnit: tx.fromAmountBaseUnit,
            status: tx.status,
            txHash: tx.txHash,
            createdTimeMs: tx.createdTimeMs,
            raw: tx,
          })),
        );
        for (const change of changed) {
          await deps.auditStore.emit({
            actor: "system",
            action: "wallet.bridge.deposit_state_changed",
            subject: `bridge_deposit:${change.row.id}`,
            metadata: { from: change.previousState, to: change.row.state },
          });
          deps.logger.info(
            { depositId: change.row.id, from: change.previousState, to: change.row.state },
            "bridge deposit state changed",
          );
        }
        // Reconciliation flag: stuck non-terminal deposits surface to admin.
        const deposits = await deps.bridgeStore.listDepositsByWallet(address.walletAddress);
        for (const deposit of deposits) {
          const terminal = deposit.state === "completed" || deposit.state === "failed";
          const stuckMs = Date.now() - new Date(deposit.createdAt).getTime();
          if (terminal || stuckMs < RECONCILE_AFTER_MS || reconciled.has(deposit.id)) continue;
          reconciled.add(deposit.id);
          await deps.auditStore.emit({
            actor: "system",
            action: "wallet.bridge.reconciliation_flagged",
            subject: `bridge_deposit:${deposit.id}`,
            metadata: { state: deposit.state, stuckMs },
          });
        }
      }
    } catch (error) {
      deps.logger.error({ error }, "bridge poller tick failed");
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      deps.logger.info({ intervalMs }, "bridge poller started");
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
};
