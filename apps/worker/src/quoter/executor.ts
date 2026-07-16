import type { QuoteIntent, RestingQuote } from "./engine.js";

/**
 * Side-effect boundary of the maker loop. The manager computes intents with
 * the pure engine and hands them here; only the executor knows whether that
 * means "record what WOULD happen" (shadow) or real CLOB orders + relayer
 * merges (live).
 *
 * SHADOW is the only executor constructed today. The live executor requires
 * the W4 deposit-wallet order path (auto-executor step 10) plus on-chain
 * verified CTF adapters — both gated behind FEATURE_MAKER_LOOP_LIVE and the
 * RFC-0003 rollout ladder.
 */

export type ExecResult<T> = { ok: true; value: T } | { ok: false; message: string };

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
}

/** Shadow: every action succeeds instantly and touches nothing external. */
export const createShadowExecutor = (): QuoterExecutor => ({
  mode: "shadow",
  place: async (intent) => ({ ok: true, value: { ...intent, orderId: null } }),
  cancel: async () => ({ ok: true, value: undefined }),
  mergePairs: async () => ({ ok: true, value: { transactionId: null } }),
});
