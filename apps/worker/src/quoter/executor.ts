import type { TickSize } from "@mx2/rules";
import type { QuoteSessionMode } from "@mx2/db";
import type { QuoteIntent, RestingQuote, VenueOpenOrder } from "./engine.js";

/**
 * Side-effect boundary of the maker loop. The manager computes intents with
 * the pure engine and hands them here; only the executor knows whether that
 * means "record what WOULD happen" (shadow) or real CLOB orders + relayer
 * merges (live). The manager resolves an executor PER CYCLE through the
 * provider so a session's mode flip (shadow → confirm → live) takes effect
 * within one cycle — and a missing live prerequisite HALTS the session
 * (visible, fail-closed) instead of silently shadowing.
 */

export type ExecResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface QuoterLoopContext {
  readonly ruleId: string;
  readonly walletAddress: string;
  readonly market: {
    readonly conditionId: string;
    readonly yesTokenId: string;
    readonly noTokenId: string;
    readonly negRisk: boolean;
    readonly tickSize: TickSize;
  };
}

export interface QuoterExecutor {
  readonly mode: "shadow" | "live";
  /** Returns the resting quote as the venue sees it (orderId null in shadow). */
  place(intent: QuoteIntent, idempotencyKey: string): Promise<ExecResult<RestingQuote>>;
  cancel(quote: RestingQuote, idempotencyKey: string): Promise<ExecResult<void>>;
  /** Merge whole YES+NO pairs back to collateral (gasless via relayer). */
  mergePairs(
    pairs: number,
    idempotencyKey: string,
  ): Promise<ExecResult<{ transactionId: string | null }>>;
  /** The venue's open orders for this loop's tokens (fill/restart reconcile). */
  syncOpenOrders(): Promise<ExecResult<VenueOpenOrder[]>>;
  /** Relayer merge transaction state (null = untrackable / not applicable). */
  mergeState(transactionId: string): Promise<ExecResult<"pending" | "confirmed" | "failed">>;
}

export type ExecutorResolution =
  | { readonly executor: QuoterExecutor }
  | { readonly unavailable: string };

/**
 * Resolves the executor for one loop cycle. `sessionMode` comes from the
 * session row re-read at the top of the cycle. Shadow always resolves; live
 * (used by both "confirm" and "live" session modes — confirm gates WHEN
 * batches execute, not HOW) requires every W2–W4 prerequisite.
 */
export interface QuoterExecutorProvider {
  forLoop(ctx: QuoterLoopContext, sessionMode: QuoteSessionMode): Promise<ExecutorResolution>;
}

/** Shadow: every action succeeds instantly and touches nothing external. */
export const createShadowExecutor = (): QuoterExecutor => ({
  mode: "shadow",
  place: async (intent) => ({ ok: true, value: { ...intent, orderId: null } }),
  cancel: async () => ({ ok: true, value: undefined }),
  mergePairs: async () => ({ ok: true, value: { transactionId: null } }),
  syncOpenOrders: async () => ({ ok: true, value: [] }),
  mergeState: async () => ({ ok: true, value: "confirmed" }),
});

/** Provider that can only ever shadow (FEATURE_MAKER_LOOP_LIVE off). */
export const createShadowOnlyProvider = (): QuoterExecutorProvider => {
  const shadow = createShadowExecutor();
  return {
    forLoop: async (_ctx, sessionMode) =>
      sessionMode === "shadow" ? { executor: shadow } : { unavailable: "maker_loop_live_disabled" },
  };
};
