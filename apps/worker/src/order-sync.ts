import { getAddress } from "viem";
import { decryptCredentials } from "@mx2/core";
import type { Logger } from "@mx2/observability";
import type {
  AuditStore,
  OrderIntentRow,
  OrderIntentStore,
  TradingAccountClobCredentialStore,
  TradingAccountStore,
} from "@mx2/db";
import type {
  AuthenticatedClobClient,
  L2Credentials,
  OpenOrder,
  UserTrade,
} from "@mx2/polymarket-client";

/**
 * Order fill reconciliation (read-only against the CLOB). Before this loop,
 * order_intents stopped at "submitted" forever — the terminal could place an
 * order but never tell the user it filled. Each pass:
 *
 *   present in GET /data/orders  → acknowledged (+ partial-fill progress)
 *   absent, fills cover the size → filled (size-weighted avg price)
 *   absent, partial/no fills     → cancelled (after a grace period)
 *   trades call failed           → untouched, retried next pass (fail-closed)
 *
 * Statuses only ever advance (store-level CAS on in-flight statuses); no
 * orders are placed, modified, or cancelled here — kill switches unaffected.
 */
export interface OrderSyncOptions {
  logger: Logger;
  encryptionMasterKey: string;
  orderIntents: OrderIntentStore;
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  tradingClobClient: AuthenticatedClobClient;
  auditStore: AuditStore;
  intervalMs?: number;
  /** Intents younger than this are never resolved to cancelled on absence —
   * the CLOB's open-orders view can lag a fresh submission. */
  disappearGraceMs?: number;
  batchLimit?: number;
}

export interface OrderSyncLoop {
  start(): void;
  /** One reconciliation pass (exposed for tests). */
  runOnce(): Promise<void>;
  stop(): void;
}

/** Total size + weighted notional matched for one of OUR order ids in a trade set. */
const fillsForOrder = (
  trades: readonly UserTrade[],
  clobOrderId: string,
): { size: number; notional: number } => {
  let size = 0;
  let notional = 0;
  for (const trade of trades) {
    if (trade.taker_order_id === clobOrderId) {
      const s = Number(trade.size);
      const p = Number(trade.price);
      if (Number.isFinite(s) && Number.isFinite(p)) {
        size += s;
        notional += s * p;
      }
    }
    for (const maker of trade.maker_orders) {
      if (maker.order_id === clobOrderId) {
        const s = Number(maker.matched_amount);
        const p = Number(maker.price);
        if (Number.isFinite(s) && Number.isFinite(p)) {
          size += s;
          notional += s * p;
        }
      }
    }
  }
  return { size, notional };
};

const SIZE_EPS = 1e-6;

export const createOrderSyncLoop = (opts: OrderSyncOptions): OrderSyncLoop => {
  const {
    logger,
    orderIntents,
    tradingAccounts,
    accountClobCredentials,
    tradingClobClient,
    auditStore,
  } = opts;
  const intervalMs = opts.intervalMs ?? 20_000;
  const disappearGraceMs = opts.disappearGraceMs ?? 120_000;
  const batchLimit = opts.batchLimit ?? 200;

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  /** Throttle repeated "account/creds unavailable" warnings per account. */
  const warnedAt = new Map<string, number>();

  const warnThrottled = (key: string, msg: string, ctx: Record<string, unknown>): void => {
    const now = Date.now();
    if (now - (warnedAt.get(key) ?? 0) < 3_600_000) return;
    warnedAt.set(key, now);
    logger.warn(ctx, msg);
  };

  const audit = async (
    action: "order.acknowledged" | "order.partially_filled" | "order.filled" | "order.cancelled",
    intent: OrderIntentRow,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    const meta = intent.metadata as Record<string, unknown> | null;
    await auditStore.emit({
      actor: intent.walletAddress,
      action,
      subject: `intent:${intent.id}`,
      metadata: {
        intentId: intent.id,
        clobOrderId: intent.clobOrderId,
        tokenId: intent.tokenId,
        side: intent.side,
        ...(typeof meta?.["ruleId"] === "string" ? { ruleId: meta["ruleId"] } : {}),
        ...extra,
      },
    });
  };

  const syncAccountGroup = async (
    ownerWallet: string,
    tradingAccountId: string,
    intents: OrderIntentRow[],
  ): Promise<void> => {
    const now = new Date();
    const account = await tradingAccounts.findByOwner(ownerWallet, tradingAccountId);
    if (!account || account.archivedAt !== null) {
      warnThrottled(
        `account:${tradingAccountId}`,
        "Order-sync: trading account missing/archived — stamping intents to avoid head-of-line",
        { tradingAccountId, count: intents.length },
      );
      for (const intent of intents)
        await orderIntents.updateFillState(intent.id, { lastSyncedAt: now });
      return;
    }
    const credsRow = await accountClobCredentials.find(account.id);
    if (!credsRow) {
      warnThrottled(
        `creds:${account.id}`,
        "Order-sync: no CLOB credentials for account — cannot reconcile",
        { tradingAccountId: account.id, count: intents.length },
      );
      for (const intent of intents)
        await orderIntents.updateFillState(intent.id, { lastSyncedAt: now });
      return;
    }
    let creds: L2Credentials;
    try {
      creds = decryptCredentials<L2Credentials>(
        credsRow.encryptedCreds as Parameters<typeof decryptCredentials>[0],
        opts.encryptionMasterKey,
      );
    } catch (e) {
      warnThrottled(`decrypt:${account.id}`, "Order-sync: CLOB credentials unreadable", {
        tradingAccountId: account.id,
        err: e instanceof Error ? e.message : String(e),
      });
      for (const intent of intents)
        await orderIntents.updateFillState(intent.id, { lastSyncedAt: now });
      return;
    }
    const address = getAddress(account.signerAddress as `0x${string}`);

    const openResult = await tradingClobClient.getOpenOrders(address, creds);
    if (!openResult.ok) {
      // Transient upstream failure: leave everything untouched and retry.
      logger.warn(
        { tradingAccountId: account.id, error: openResult.error.code },
        "Order-sync: getOpenOrders failed — skipping account this pass",
      );
      return;
    }
    const openById = new Map<string, OpenOrder>(openResult.value.map((o) => [o.id, o]));
    /** One trades fetch per token per pass, shared across this account's intents. */
    const tradesByToken = new Map<string, UserTrade[] | null>();
    const tradesFor = async (tokenId: string): Promise<UserTrade[] | null> => {
      if (!tradesByToken.has(tokenId)) {
        const result = await tradingClobClient.getUserTrades(address, creds, {
          asset_id: tokenId,
        });
        tradesByToken.set(tokenId, result.ok ? result.value : null);
        if (!result.ok) {
          logger.warn(
            { tradingAccountId: account.id, tokenId, error: result.error.code },
            "Order-sync: getUserTrades failed — affected intents retried next pass",
          );
        }
      }
      return tradesByToken.get(tokenId) ?? null;
    };

    for (const intent of intents) {
      const clobOrderId = intent.clobOrderId;
      if (clobOrderId === null) continue; // listForSync excludes these anyway
      const open = openById.get(clobOrderId);

      if (open !== undefined) {
        const matched = Number(open.size_matched);
        const prevFilled = Number(intent.filledSize);
        const progressed = Number.isFinite(matched) && matched > prevFilled + SIZE_EPS;
        if (intent.status === "submitted") {
          await audit("order.acknowledged", intent, { filledSize: open.size_matched });
        }
        if (progressed && matched > SIZE_EPS) {
          await audit("order.partially_filled", intent, {
            filledSize: open.size_matched,
            originalSize: open.original_size,
          });
        }
        await orderIntents.updateFillState(intent.id, {
          ...(intent.status === "submitted" ? { status: "acknowledged" as const } : {}),
          ...(Number.isFinite(matched) ? { filledSize: String(matched) } : {}),
          lastSyncedAt: now,
        });
        continue;
      }

      // Not resting anymore: it filled, was cancelled, or hasn't propagated yet.
      if (Date.now() - intent.createdAt.getTime() < disappearGraceMs) {
        await orderIntents.updateFillState(intent.id, { lastSyncedAt: now });
        continue;
      }
      const trades = await tradesFor(intent.tokenId);
      if (trades === null) continue; // fetch failed — fail closed, retry next pass

      const { size: totalFilled, notional } = fillsForOrder(trades, clobOrderId);
      const orderSize = Number(intent.size);
      const avgFillPrice = totalFilled > SIZE_EPS ? String(notional / totalFilled) : null;

      if (totalFilled >= orderSize - SIZE_EPS && orderSize > 0) {
        await orderIntents.updateFillState(intent.id, {
          status: "filled",
          filledSize: String(totalFilled),
          avgFillPrice,
          lastSyncedAt: now,
        });
        await audit("order.filled", intent, { filledSize: String(totalFilled), avgFillPrice });
      } else {
        await orderIntents.updateFillState(intent.id, {
          status: "cancelled",
          filledSize: String(totalFilled),
          avgFillPrice,
          lastSyncedAt: now,
        });
        await audit("order.cancelled", intent, {
          filledSize: String(totalFilled),
          avgFillPrice,
          partiallyFilled: totalFilled > SIZE_EPS,
        });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const pending = await orderIntents.listForSync(batchLimit);
      if (pending.length === 0) return;
      const groups = new Map<
        string,
        { wallet: string; accountId: string; rows: OrderIntentRow[] }
      >();
      for (const intent of pending) {
        if (intent.tradingAccountId === null) {
          // Legacy rows without an account can never be reconciled — stamp so
          // they don't head-of-line block the sync ordering.
          await orderIntents.updateFillState(intent.id, { lastSyncedAt: new Date() });
          continue;
        }
        const key = `${intent.walletAddress}:${intent.tradingAccountId}`;
        const group = groups.get(key) ?? {
          wallet: intent.walletAddress,
          accountId: intent.tradingAccountId,
          rows: [],
        };
        group.rows.push(intent);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        try {
          await syncAccountGroup(group.wallet, group.accountId, group.rows);
        } catch (e) {
          logger.warn(
            { err: e, tradingAccountId: group.accountId },
            "Order-sync: account group failed",
          );
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      timer = setInterval(() => {
        runOnce().catch((e: unknown) => logger.warn({ err: e }, "Order-sync pass failed"));
      }, intervalMs);
      logger.info({ intervalMs }, "Order-sync loop started (fill reconciliation)");
    },
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
};
