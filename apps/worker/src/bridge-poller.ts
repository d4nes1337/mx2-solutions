import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  BridgeAddressRow,
  BridgeStore,
  NotificationOutboxStore,
  PrivyWalletStore,
} from "@mx2/db";
import {
  BRIDGE_WITHDRAWAL_STATE_RANK,
  WITHDRAWAL_TERMINAL,
  bridgeWithdrawalStateFromRelayer,
} from "@mx2/db";
import type { BridgeClient, DepositWalletRelayer } from "@mx2/polymarket-client";

/**
 * Bridge deposit status poller (ADR-0017 follow-through). Two-speed polling:
 * every tick (~12s) it re-checks ACTIVE addresses — those carrying a
 * non-terminal transfer or freshly created — so in-flight deposits and
 * withdrawal legs advance at UI speed; the full least-recently-checked sweep
 * still runs on the slow interval (60s). Deposit rows go through the
 * state-machine-guarded store (states never regress; every transition is
 * audited). Read-only against the Bridge; failures are logged and retried
 * next tick, never fatal.
 *
 * When a relayer + Privy wallet store are supplied (bridge withdrawals
 * enabled), each tick also polls the relayer for bridge withdrawals stuck on
 * their Polygon leg (`polygon_submitted`), advancing them to
 * `polygon_confirmed` / `failed_polygon` — the Bridge status API only sees
 * the funds AFTER this leg mines, so without this pass a failed Polygon leg
 * would sit at polygon_submitted forever.
 *
 * Reconciliation: deposits AND withdrawals stuck non-terminal past
 * RECONCILE_AFTER_MS are flagged once per poller lifetime with an audit event
 * for the admin surface.
 */

export interface BridgePollerDeps {
  logger: Logger;
  bridgeStore: BridgeStore;
  bridgeClient: BridgeClient;
  auditStore: AuditStore;
  /** Slow full-sweep cadence. */
  intervalMs?: number;
  /** Re-check an address at most this often on the slow sweep. */
  staleAfterMs?: number;
  /** Addresses polled per pass (Bridge traffic bound). */
  batchSize?: number;
  /** Fast cadence for addresses with in-flight transfers (the tick rate). */
  activeIntervalMs?: number;
  /** Re-check an ACTIVE address at most this often. */
  activeStaleAfterMs?: number;
  /** Present only when bridge withdrawals are enabled (needs relayer creds). */
  depositWalletRelayer?: DepositWalletRelayer;
  privyWallets?: PrivyWalletStore;
  /** Notification outbox (FEATURE_NOTIFICATIONS): transfer completions. */
  outbox?: NotificationOutboxStore;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_ACTIVE_INTERVAL_MS = 12_000;
const DEFAULT_ACTIVE_STALE_AFTER_MS = 10_000;
/** Withdrawals polled against the relayer per tick. */
const RELAYER_POLL_LIMIT = 20;
/** Transfers non-terminal for longer than this get a reconciliation flag (2h). */
const RECONCILE_AFTER_MS = 2 * 60 * 60 * 1000;

const NON_TERMINAL_WITHDRAWAL_STATES = Object.keys(BRIDGE_WITHDRAWAL_STATE_RANK).filter(
  (state) => !WITHDRAWAL_TERMINAL.has(state),
);

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
  const activeIntervalMs = deps.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
  const activeStaleAfterMs = deps.activeStaleAfterMs ?? DEFAULT_ACTIVE_STALE_AFTER_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastIdlePassAt = 0;
  const reconciled = new Set<string>();

  /** Pull provider status for one address and advance its transfer rows. */
  const processAddress = async (address: BridgeAddressRow): Promise<void> => {
    const status = await deps.bridgeClient.getStatus(address.address);
    await deps.bridgeStore.markAddressChecked(address.id);
    if (!status.ok) {
      deps.logger.warn(
        { address: address.address, error: status.error.code },
        "bridge status poll failed",
      );
      return;
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
          metadata: { from: change.previousState, to: change.row.state, source: "bridge" },
        });
        if (deps.outbox && change.row.state === "completed") {
          await deps.outbox
            .enqueue({
              walletAddress: change.row.walletAddress,
              kind: "withdrawal_completed",
              dedupeKey: `bridge_withdrawal:${change.row.id}:completed`,
              payload: { amountUsd: String(change.row.amountUsd) },
            })
            .catch((e: unknown) =>
              deps.logger.warn({ err: e }, "withdrawal notification enqueue failed"),
            );
        }
      }
      return;
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
      if (deps.outbox && change.row.state === "completed") {
        await deps.outbox
          .enqueue({
            walletAddress: change.row.walletAddress,
            kind: "deposit_completed",
            dedupeKey: `bridge_deposit:${change.row.id}:completed`,
            payload: {},
          })
          .catch((e: unknown) =>
            deps.logger.warn({ err: e }, "deposit notification enqueue failed"),
          );
      }
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
  };

  /**
   * Relayer pass: bridge withdrawals whose Polygon leg is submitted but not
   * yet observed. First (and only) writer of `polygon_confirmed`.
   */
  const pollWithdrawalRelayerLegs = async (): Promise<void> => {
    const relayer = deps.depositWalletRelayer;
    if (!relayer?.enabled || !deps.privyWallets) return;
    const rows = await deps.bridgeStore.listWithdrawalsByStates(
      ["polygon_submitted"],
      RELAYER_POLL_LIMIT,
    );
    for (const row of rows) {
      if (!row.relayerTransactionId) continue;
      try {
        const previousState = row.state;
        const wallet = await deps.privyWallets.find(row.walletAddress);
        if (!wallet) continue;
        const state = await relayer.getTransactionState(
          { ownerAddress: wallet.embeddedAddress, ownerWalletId: wallet.privyWalletId },
          row.relayerTransactionId,
        );
        if (!state.ok) continue;
        const next = bridgeWithdrawalStateFromRelayer(state.value.state);
        if (!next) continue;
        const updated = await deps.bridgeStore.advanceWithdrawalState(row.id, next, {
          ...(state.value.transactionHash ? { polygonTxHash: state.value.transactionHash } : {}),
          ...(next === "failed_polygon" ? { error: state.value.state } : {}),
        });
        if (!updated) continue;
        await deps.auditStore.emit({
          actor: "system",
          action: "wallet.bridge.withdraw_state_changed",
          subject: `bridge_withdrawal:${row.id}`,
          metadata: {
            from: previousState,
            to: updated.state,
            source: "relayer",
            relayerTransactionId: row.relayerTransactionId,
          },
        });
        deps.logger.info(
          { bridgeWithdrawalId: row.id, from: previousState, to: updated.state },
          "bridge withdrawal polygon leg advanced",
        );
      } catch (error) {
        deps.logger.warn({ bridgeWithdrawalId: row.id, error }, "withdrawal relayer poll failed");
      }
    }
  };

  /** Stuck-withdrawal reconciliation — mirror of the deposit-side flag. */
  const flagStuckWithdrawals = async (): Promise<void> => {
    const rows = await deps.bridgeStore.listWithdrawalsByStates(
      NON_TERMINAL_WITHDRAWAL_STATES,
      100,
    );
    for (const row of rows) {
      const key = `bw:${row.id}`;
      const stuckMs = Date.now() - new Date(row.createdAt).getTime();
      if (stuckMs < RECONCILE_AFTER_MS || reconciled.has(key)) continue;
      reconciled.add(key);
      await deps.auditStore.emit({
        actor: "system",
        action: "wallet.bridge.reconciliation_flagged",
        subject: `bridge_withdrawal:${row.id}`,
        metadata: { state: row.state, stuckMs },
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return; // never overlap ticks
    inFlight = true;
    try {
      const handled = new Set<string>();

      // Fast pass: addresses with in-flight transfers (or freshly created).
      const active = await deps.bridgeStore.listActivePollableAddresses(
        new Date(Date.now() - activeStaleAfterMs),
        batchSize,
      );
      for (const address of active) {
        handled.add(address.id);
        await processAddress(address);
      }

      // Slow full sweep on the original cadence.
      if (Date.now() - lastIdlePassAt >= intervalMs) {
        lastIdlePassAt = Date.now();
        const addresses = await deps.bridgeStore.listPollableAddresses(
          new Date(Date.now() - staleAfterMs),
          batchSize,
        );
        for (const address of addresses) {
          if (handled.has(address.id)) continue;
          await processAddress(address);
        }
      }

      await pollWithdrawalRelayerLegs();
      await flagStuckWithdrawals();
    } catch (error) {
      deps.logger.error({ error }, "bridge poller tick failed");
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      const tickEveryMs = Math.min(activeIntervalMs, intervalMs);
      timer = setInterval(() => void tick(), tickEveryMs);
      deps.logger.info(
        {
          tickEveryMs,
          idlePassMs: intervalMs,
          relayerPass: Boolean(deps.depositWalletRelayer?.enabled),
        },
        "bridge poller started",
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
};
