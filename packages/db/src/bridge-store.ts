import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.js";
import {
  bridgeAddresses,
  bridgeDeposits,
  bridgeWithdrawals,
  type BridgeAddressRow,
  type BridgeDepositRow,
  type BridgeWithdrawalRow,
  type NewBridgeAddressRow,
  type NewBridgeWithdrawalRow,
} from "./schema.js";

// ── Deposit state machine ────────────────────────────────────────────────────

/** Ordered ranks — a deposit's state may only move forward, never regress. */
const DEPOSIT_STATE_RANK: Record<string, number> = {
  detected: 0,
  processing: 1,
  origin_confirmed: 2,
  submitted: 3,
  completed: 4,
  failed: 4,
  /** Retired in favor of another row for the same transfer (migration 0019). */
  superseded: 4,
  /** No provider progress for the expiry horizon — record abandoned (0019). */
  expired: 4,
};

export type BridgeDepositState = keyof typeof DEPOSIT_STATE_RANK;

/** Provider status → our state. Unknown statuses bucket into "processing". */
export const depositStateFromProvider = (providerStatus: string): BridgeDepositState => {
  switch (providerStatus) {
    case "DEPOSIT_DETECTED":
      return "detected";
    case "PROCESSING":
      return "processing";
    case "ORIGIN_TX_CONFIRMED":
      return "origin_confirmed";
    case "SUBMITTED":
      return "submitted";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    default:
      return "processing";
  }
};

export interface BridgeStatusTransactionInput {
  fromChainId?: string | undefined;
  fromTokenAddress?: string | undefined;
  fromAmountBaseUnit?: string | undefined;
  status: string;
  txHash?: string | null | undefined;
  createdTimeMs?: number | undefined;
  raw?: unknown;
}

export interface UpsertDepositsResult {
  /** Deposits whose state changed this upsert (for audit emission). */
  changed: { row: BridgeDepositRow; previousState: string | null }[];
}

// ── Bridge withdrawal state machine ──────────────────────────────────────────

/** Terminal bridge-withdrawal states — rows here never move again. */
export const WITHDRAWAL_TERMINAL = new Set([
  "completed",
  "failed_address",
  "failed_polygon",
  "failed_bridge",
]);

/** Ordered ranks for the happy path — forward-only, like deposits. */
export const BRIDGE_WITHDRAWAL_STATE_RANK: Record<string, number> = {
  requested: 0,
  address_created: 1,
  polygon_submitted: 2,
  polygon_confirmed: 3,
  bridging: 4,
  completed: 5,
};

/** Deposit states considered terminal (mirrors DEPOSIT_STATE_RANK top). */
export const DEPOSIT_TERMINAL = ["completed", "failed", "superseded", "expired"];

/**
 * Relayer transaction state → bridge-withdrawal Polygon-leg outcome. Takes a
 * plain string so this package stays free of polymarket-client imports.
 * Non-final relayer states map to null (no transition yet).
 */
export const bridgeWithdrawalStateFromRelayer = (
  relayerState: string,
): "polygon_confirmed" | "failed_polygon" | null =>
  relayerState === "STATE_MINED" || relayerState === "STATE_CONFIRMED"
    ? "polygon_confirmed"
    : relayerState === "STATE_FAILED" || relayerState === "STATE_INVALID"
      ? "failed_polygon"
      : null;

export interface BridgeStore {
  /** Idempotent per (wallet, kind, address): re-saving refreshes nothing. */
  saveAddress(row: NewBridgeAddressRow): Promise<BridgeAddressRow>;
  listAddresses(
    walletAddress: string,
    kind?: "deposit" | "withdrawal",
  ): Promise<BridgeAddressRow[]>;
  /**
   * Addresses due a status poll: unchecked, or last checked before `staleBefore`.
   * Oldest-checked first, bounded by `limit`.
   */
  listPollableAddresses(staleBefore: Date, limit: number): Promise<BridgeAddressRow[]>;
  /**
   * Pollable addresses that are ACTIVE: carrying a non-terminal deposit or
   * withdrawal, or created within `activeWindowMs` (a fresh deposit address
   * has no rows yet but the user is likely mid-transfer). Drives the fast
   * poller cadence without hitting the Bridge for long-idle addresses.
   */
  listActivePollableAddresses(
    staleBefore: Date,
    limit: number,
    activeWindowMs?: number,
  ): Promise<BridgeAddressRow[]>;
  markAddressChecked(id: string): Promise<void>;
  /**
   * Merge provider status transactions into deposit rows. Insert-or-forward:
   * dedupe key (address, fromChain, fromToken, amount, createdTimeMs); state
   * never regresses; terminal rows only refresh txHash/raw.
   */
  upsertDepositsFromStatus(
    address: BridgeAddressRow,
    transactions: readonly BridgeStatusTransactionInput[],
  ): Promise<UpsertDepositsResult>;
  listDepositsByWallet(walletAddress: string, limit?: number): Promise<BridgeDepositRow[]>;
  /**
   * User-initiated hide of a transfer record (kept in history, removed from
   * active surfaces). Owner-scoped; idempotent — an already-dismissed row
   * returns null.
   */
  dismissDeposit(walletAddress: string, depositId: string): Promise<BridgeDepositRow | null>;
  /** All non-terminal deposits, oldest first (reconciliation sweep input). */
  listNonTerminalDeposits(limit: number): Promise<BridgeDepositRow[]>;
  /**
   * Non-terminal deposits with no progress since `cutoff` → `expired`.
   * CAS per row: a concurrent provider poll advancing the state wins.
   */
  expireStaleDeposits(cutoff: Date, limit: number): Promise<UpsertDepositsResult["changed"]>;
  /**
   * Complete a deposit from on-chain evidence (funds observed in the deposit
   * wallet) rather than provider status. Refuses terminal rows.
   */
  completeDepositFromChain(depositId: string): Promise<BridgeDepositRow | null>;

  // ── Withdrawals (two-leg ledger; route wiring in the withdrawals slice) ──
  createWithdrawal(row: NewBridgeWithdrawalRow): Promise<BridgeWithdrawalRow | null>;
  findWithdrawalByIdempotencyKey(
    walletAddress: string,
    idempotencyKey: string,
  ): Promise<BridgeWithdrawalRow | null>;
  listWithdrawalsByWallet(walletAddress: string, limit?: number): Promise<BridgeWithdrawalRow[]>;
  updateWithdrawalState(
    id: string,
    state: string,
    patch?: Partial<
      Pick<
        BridgeWithdrawalRow,
        | "bridgeAddressId"
        | "quoteId"
        | "estToTokenBaseUnit"
        | "relayerTransactionId"
        | "polygonTxHash"
        | "bridgeTxHash"
        | "error"
      >
    >,
  ): Promise<BridgeWithdrawalRow | null>;
  /**
   * Advance withdrawals tied to a bridge address from provider status:
   * funds detected → bridging; COMPLETED → completed (+bridgeTxHash);
   * FAILED → failed_bridge. Terminal rows never move.
   */
  updateWithdrawalsFromStatus(
    address: BridgeAddressRow,
    transactions: readonly BridgeStatusTransactionInput[],
  ): Promise<{ changed: { row: BridgeWithdrawalRow; previousState: string }[] }>;
  /**
   * Forward-only sibling of updateWithdrawalState: refuses terminal rows and
   * rank regressions (a slow relayer poll returning MINED must never pull a
   * row already at `bridging` back to `polygon_confirmed`). Failure states are
   * writable from any non-terminal state. Returns null when nothing moved.
   */
  advanceWithdrawalState(
    id: string,
    state: string,
    patch?: Parameters<BridgeStore["updateWithdrawalState"]>[2],
  ): Promise<BridgeWithdrawalRow | null>;
  /** Withdrawals currently in one of `states`, oldest first. */
  listWithdrawalsByStates(states: readonly string[], limit: number): Promise<BridgeWithdrawalRow[]>;
}

export const createBridgeStore = (db: Database): BridgeStore => {
  return {
    async saveAddress(row) {
      const [saved] = await db
        .insert(bridgeAddresses)
        .values(row)
        .onConflictDoNothing()
        .returning();
      if (saved) return saved;
      const [existing] = await db
        .select()
        .from(bridgeAddresses)
        .where(
          and(
            eq(bridgeAddresses.walletAddress, row.walletAddress),
            eq(bridgeAddresses.kind, row.kind ?? "deposit"),
            eq(bridgeAddresses.address, row.address),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Failed to save bridge address");
      return existing;
    },

    async listAddresses(walletAddress, kind) {
      return db
        .select()
        .from(bridgeAddresses)
        .where(
          and(
            eq(bridgeAddresses.walletAddress, walletAddress),
            ...(kind ? [eq(bridgeAddresses.kind, kind)] : []),
          ),
        )
        .orderBy(desc(bridgeAddresses.createdAt));
    },

    async listPollableAddresses(staleBefore, limit) {
      return db
        .select()
        .from(bridgeAddresses)
        .where(
          or(isNull(bridgeAddresses.lastCheckedAt), lt(bridgeAddresses.lastCheckedAt, staleBefore)),
        )
        .orderBy(asc(bridgeAddresses.lastCheckedAt))
        .limit(limit);
    },

    async listActivePollableAddresses(staleBefore, limit, activeWindowMs = 30 * 60 * 1000) {
      const activeSince = new Date(Date.now() - activeWindowMs);
      const activeDeposit = db
        .select({ one: sql`1` })
        .from(bridgeDeposits)
        .where(
          and(
            eq(bridgeDeposits.bridgeAddressId, bridgeAddresses.id),
            notInArray(bridgeDeposits.state, DEPOSIT_TERMINAL),
          ),
        );
      const activeWithdrawal = db
        .select({ one: sql`1` })
        .from(bridgeWithdrawals)
        .where(
          and(
            eq(bridgeWithdrawals.bridgeAddressId, bridgeAddresses.id),
            notInArray(bridgeWithdrawals.state, [...WITHDRAWAL_TERMINAL]),
          ),
        );
      return db
        .select()
        .from(bridgeAddresses)
        .where(
          and(
            or(
              isNull(bridgeAddresses.lastCheckedAt),
              lt(bridgeAddresses.lastCheckedAt, staleBefore),
            ),
            or(
              gt(bridgeAddresses.createdAt, activeSince),
              exists(activeDeposit),
              exists(activeWithdrawal),
            ),
          ),
        )
        .orderBy(asc(bridgeAddresses.lastCheckedAt))
        .limit(limit);
    },

    async markAddressChecked(id) {
      await db
        .update(bridgeAddresses)
        .set({ lastCheckedAt: sql`now()` })
        .where(eq(bridgeAddresses.id, id));
    },

    async upsertDepositsFromStatus(address, transactions) {
      const changed: UpsertDepositsResult["changed"] = [];
      for (const tx of transactions) {
        const state = depositStateFromProvider(tx.status);
        const ts = tx.createdTimeMs ?? 0;
        const identity = [
          eq(bridgeDeposits.bridgeAddressId, address.id),
          eq(bridgeDeposits.fromChainId, tx.fromChainId ?? ""),
          eq(bridgeDeposits.fromTokenAddress, tx.fromTokenAddress ?? ""),
          eq(bridgeDeposits.fromAmountBaseUnit, tx.fromAmountBaseUnit ?? ""),
        ];

        // Matching ladder, strongest identity first. createdTimeMs is optional
        // upstream and may appear on a later poll than the first insert, so the
        // timestamp can never be the primary identity — treating it as one is
        // what orphaned rows at "detected" before migration 0019.
        let existing: BridgeDepositRow | null = null;
        if (tx.txHash) {
          const [byHash] = await db
            .select()
            .from(bridgeDeposits)
            .where(and(...identity, eq(bridgeDeposits.txHash, tx.txHash)))
            .limit(1);
          existing = byHash ?? null;
        }
        if (!existing) {
          const [byKey] = await db
            .select()
            .from(bridgeDeposits)
            .where(and(...identity, eq(bridgeDeposits.providerCreatedTimeMs, ts)))
            .limit(1);
          existing = byKey ?? null;
        }
        if (!existing) {
          // Zero-timestamp adoption, either direction: a non-terminal sibling
          // whose key differs only in one side lacking createdTimeMs is the
          // same transfer. Ambiguity note: same address+chain+token+amount with
          // no txHash and no timestamp cannot be told apart — adopting is the
          // safe default (a duplicate stuck row is worse than a merged one).
          const [adoptable] = await db
            .select()
            .from(bridgeDeposits)
            .where(
              and(
                ...identity,
                ...(ts !== 0 ? [eq(bridgeDeposits.providerCreatedTimeMs, 0)] : []),
                notInArray(bridgeDeposits.state, DEPOSIT_TERMINAL),
              ),
            )
            .orderBy(desc(bridgeDeposits.providerCreatedTimeMs))
            .limit(1);
          existing = adoptable ?? null;
        }

        // Normalize the adopted row onto the provider's timestamp. If a sibling
        // already owns that key (both halves of the transfer were inserted),
        // keep the further-along row and retire the other as superseded.
        if (existing && ts !== 0 && existing.providerCreatedTimeMs !== ts) {
          const [sibling] = await db
            .select()
            .from(bridgeDeposits)
            .where(
              and(
                ...identity,
                eq(bridgeDeposits.providerCreatedTimeMs, ts),
                ne(bridgeDeposits.id, existing.id),
              ),
            )
            .limit(1);
          if (sibling) {
            const keep =
              (DEPOSIT_STATE_RANK[sibling.state] ?? 0) >= (DEPOSIT_STATE_RANK[existing.state] ?? 0)
                ? sibling
                : existing;
            const lose = keep.id === sibling.id ? existing : sibling;
            if (!DEPOSIT_TERMINAL.includes(lose.state)) {
              const [retired] = await db
                .update(bridgeDeposits)
                .set({
                  state: "superseded",
                  supersededByDepositId: keep.id,
                  updatedAt: sql`now()`,
                })
                .where(eq(bridgeDeposits.id, lose.id))
                .returning();
              if (retired) changed.push({ row: retired, previousState: lose.state });
            }
            existing = keep;
          } else {
            const [moved] = await db
              .update(bridgeDeposits)
              .set({ providerCreatedTimeMs: ts, updatedAt: sql`now()` })
              .where(eq(bridgeDeposits.id, existing.id))
              .returning();
            if (moved) existing = moved;
          }
        }

        if (!existing) {
          const [inserted] = await db
            .insert(bridgeDeposits)
            .values({
              walletAddress: address.walletAddress,
              bridgeAddressId: address.id,
              fromChainId: tx.fromChainId ?? "",
              fromTokenAddress: tx.fromTokenAddress ?? "",
              fromAmountBaseUnit: tx.fromAmountBaseUnit ?? "",
              providerCreatedTimeMs: ts,
              state,
              providerStatus: tx.status,
              txHash: tx.txHash ?? null,
              raw: tx.raw ?? null,
              ...(state === "completed" ? { completionSource: "provider" } : {}),
            })
            .onConflictDoNothing()
            .returning();
          if (inserted) changed.push({ row: inserted, previousState: null });
          continue;
        }

        const forward =
          (DEPOSIT_STATE_RANK[state] ?? 1) > (DEPOSIT_STATE_RANK[existing.state] ?? 0);
        const terminal = DEPOSIT_TERMINAL.includes(existing.state);
        if (terminal || (!forward && existing.txHash === (tx.txHash ?? existing.txHash))) continue;
        const [updated] = await db
          .update(bridgeDeposits)
          .set({
            ...(forward
              ? {
                  state,
                  providerStatus: tx.status,
                  ...(state === "completed" ? { completionSource: "provider" } : {}),
                }
              : {}),
            txHash: tx.txHash ?? existing.txHash,
            raw: tx.raw ?? existing.raw,
            updatedAt: sql`now()`,
          })
          .where(eq(bridgeDeposits.id, existing.id))
          .returning();
        if (updated && forward) changed.push({ row: updated, previousState: existing.state });
      }
      return { changed };
    },

    async dismissDeposit(walletAddress, depositId) {
      const [row] = await db
        .update(bridgeDeposits)
        .set({ dismissedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(bridgeDeposits.id, depositId),
            eq(bridgeDeposits.walletAddress, walletAddress),
            isNull(bridgeDeposits.dismissedAt),
          ),
        )
        .returning();
      return row ?? null;
    },

    async listNonTerminalDeposits(limit) {
      return db
        .select()
        .from(bridgeDeposits)
        .where(notInArray(bridgeDeposits.state, DEPOSIT_TERMINAL))
        .orderBy(asc(bridgeDeposits.createdAt))
        .limit(limit);
    },

    async expireStaleDeposits(cutoff, limit) {
      const stale = await db
        .select()
        .from(bridgeDeposits)
        .where(
          and(
            notInArray(bridgeDeposits.state, DEPOSIT_TERMINAL),
            lt(bridgeDeposits.updatedAt, cutoff),
          ),
        )
        .orderBy(asc(bridgeDeposits.updatedAt))
        .limit(limit);
      const changed: UpsertDepositsResult["changed"] = [];
      for (const row of stale) {
        // CAS on the observed state so a concurrent provider poll wins.
        const [expired] = await db
          .update(bridgeDeposits)
          .set({ state: "expired", updatedAt: sql`now()` })
          .where(and(eq(bridgeDeposits.id, row.id), eq(bridgeDeposits.state, row.state)))
          .returning();
        if (expired) changed.push({ row: expired, previousState: row.state });
      }
      return changed;
    },

    async completeDepositFromChain(depositId) {
      const [row] = await db
        .update(bridgeDeposits)
        .set({
          state: "completed",
          completionSource: "chain_reconciled",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bridgeDeposits.id, depositId),
            notInArray(bridgeDeposits.state, DEPOSIT_TERMINAL),
          ),
        )
        .returning();
      return row ?? null;
    },

    async listDepositsByWallet(walletAddress, limit = 50) {
      return db
        .select()
        .from(bridgeDeposits)
        .where(eq(bridgeDeposits.walletAddress, walletAddress))
        .orderBy(desc(bridgeDeposits.createdAt))
        .limit(limit);
    },

    async createWithdrawal(row) {
      const [created] = await db
        .insert(bridgeWithdrawals)
        .values(row)
        .onConflictDoNothing()
        .returning();
      return created ?? null;
    },

    async findWithdrawalByIdempotencyKey(walletAddress, idempotencyKey) {
      const [row] = await db
        .select()
        .from(bridgeWithdrawals)
        .where(
          and(
            eq(bridgeWithdrawals.walletAddress, walletAddress),
            eq(bridgeWithdrawals.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listWithdrawalsByWallet(walletAddress, limit = 50) {
      return db
        .select()
        .from(bridgeWithdrawals)
        .where(eq(bridgeWithdrawals.walletAddress, walletAddress))
        .orderBy(desc(bridgeWithdrawals.createdAt))
        .limit(limit);
    },

    async updateWithdrawalState(id, state, patch) {
      const [row] = await db
        .update(bridgeWithdrawals)
        .set({ state, ...(patch ?? {}), updatedAt: sql`now()` })
        .where(eq(bridgeWithdrawals.id, id))
        .returning();
      return row ?? null;
    },

    async advanceWithdrawalState(id, state, patch) {
      const [existing] = await db
        .select()
        .from(bridgeWithdrawals)
        .where(eq(bridgeWithdrawals.id, id))
        .limit(1);
      if (!existing || WITHDRAWAL_TERMINAL.has(existing.state)) return null;
      if (!state.startsWith("failed")) {
        const nextRank = BRIDGE_WITHDRAWAL_STATE_RANK[state];
        const currentRank = BRIDGE_WITHDRAWAL_STATE_RANK[existing.state] ?? 0;
        if (nextRank === undefined || nextRank <= currentRank) return null;
      }
      // Compare-and-set on the observed state: a concurrent writer wins and
      // this call reports "nothing moved" instead of clobbering it.
      const [row] = await db
        .update(bridgeWithdrawals)
        .set({ state, ...(patch ?? {}), updatedAt: sql`now()` })
        .where(and(eq(bridgeWithdrawals.id, id), eq(bridgeWithdrawals.state, existing.state)))
        .returning();
      return row ?? null;
    },

    async listWithdrawalsByStates(states, limit) {
      if (states.length === 0) return [];
      return db
        .select()
        .from(bridgeWithdrawals)
        .where(inArray(bridgeWithdrawals.state, [...states]))
        .orderBy(asc(bridgeWithdrawals.createdAt))
        .limit(limit);
    },

    async updateWithdrawalsFromStatus(address, transactions) {
      const rows = await db
        .select()
        .from(bridgeWithdrawals)
        .where(eq(bridgeWithdrawals.bridgeAddressId, address.id));
      const changed: { row: BridgeWithdrawalRow; previousState: string }[] = [];
      const completedTx = transactions.find((t) => t.status === "COMPLETED");
      const failedTx = transactions.find((t) => t.status === "FAILED");
      for (const row of rows) {
        if (WITHDRAWAL_TERMINAL.has(row.state)) continue;
        let next: { state: string; patch: Record<string, unknown> } | null = null;
        if (completedTx) {
          next = { state: "completed", patch: { bridgeTxHash: completedTx.txHash ?? null } };
        } else if (failedTx) {
          next = { state: "failed_bridge", patch: {} };
        } else if (transactions.length > 0 && row.state !== "bridging") {
          // The bridge saw the Polygon leg arrive — funds are in transit.
          next = { state: "bridging", patch: {} };
        }
        if (!next || next.state === row.state) continue;
        const [updated] = await db
          .update(bridgeWithdrawals)
          .set({ state: next.state, ...next.patch, updatedAt: sql`now()` })
          .where(eq(bridgeWithdrawals.id, row.id))
          .returning();
        if (updated) changed.push({ row: updated, previousState: row.state });
      }
      return { changed };
    },
  };
};
