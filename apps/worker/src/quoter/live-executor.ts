import { getAddress } from "viem";
import {
  buildMergeTransaction,
  isDepositWalletConfirmed,
  submit1271Order,
  type AuthenticatedClobClient,
  type DepositWalletOwner,
  type DepositWalletRelayer,
  type L2Credentials,
  type SignTypedDataFn,
} from "@mx2/polymarket-client";
import type { QuoterExecutor, QuoterLoopContext } from "./executor.js";

/**
 * The LIVE maker-loop executor (RFC-0003 checkpoints 3–4): real post-only GTC
 * orders through the shared POLY_1271 path (identical to the manual route and
 * the auto-executor — one contract-tested seam), merges through the gasless
 * deposit-wallet relayer batch, open orders + fill deltas from CLOB polling.
 *
 * Everything here is per-loop: the provider resolves credentials, adapter and
 * relayer owner once per cycle and hands them in; this module holds no state.
 */
export interface LiveExecutorDeps {
  ctx: QuoterLoopContext;
  clobClient: AuthenticatedClobClient;
  creds: L2Credentials;
  /** Embedded EOA (L2 identity). */
  signerAddress: string;
  depositWalletAddress: string;
  sign: SignTypedDataFn;
  relayer: DepositWalletRelayer;
  owner: DepositWalletOwner;
  /** On-chain-verified CTF adapter for this market's negRisk flavor (R-028). */
  adapterAddress: string;
}

export const createLiveExecutor = (deps: LiveExecutorDeps): QuoterExecutor => {
  const l2Address = getAddress(deps.signerAddress);
  const loopTokens = [deps.ctx.market.yesTokenId, deps.ctx.market.noTokenId];

  return {
    mode: "live",

    async place(intent, idempotencyKey) {
      const res = await submit1271Order(deps.clobClient, {
        signerAddress: deps.signerAddress,
        depositWalletAddress: deps.depositWalletAddress,
        sign: deps.sign,
        params: {
          tokenId: intent.tokenId,
          side: "BUY",
          price: intent.price,
          size: intent.size,
          tickSize: deps.ctx.market.tickSize,
          negRisk: deps.ctx.market.negRisk,
          orderType: "GTC",
          // Maker-only, always: a crossing quote is a bug, not a trade.
          postOnly: true,
        },
        creds: deps.creds,
        idempotencyKey,
      });
      if (!res.ok) return { ok: false, message: `${res.error.code}: ${res.error.message}` };
      return {
        ok: true,
        value: { ...intent, orderId: res.value.ack.orderID, sizeMatched: 0 },
      };
    },

    async cancel(quote, _idempotencyKey) {
      if (quote.orderId === null) return { ok: true, value: undefined }; // virtual
      const res = await deps.clobClient.cancelOrder(quote.orderId, deps.creds, l2Address);
      if (!res.ok) return { ok: false, message: `${res.error.code}: ${res.error.message}` };
      return { ok: true, value: undefined };
    },

    async mergePairs(pairs, _idempotencyKey) {
      let tx: { to: string; data: string; value: string };
      try {
        tx = buildMergeTransaction({
          conditionId: deps.ctx.market.conditionId,
          amountShares: pairs,
          adapterAddress: deps.adapterAddress,
        });
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      const res = await deps.relayer.executeBatch(deps.owner, [
        { target: tx.to, value: tx.value, data: tx.data },
      ]);
      if (!res.ok) return { ok: false, message: `${res.error.code}: ${res.error.message}` };
      return { ok: true, value: { transactionId: res.value.transactionId } };
    },

    async syncOpenOrders() {
      const res = await deps.clobClient.getOpenOrders(l2Address, deps.creds);
      if (!res.ok) return { ok: false, message: `${res.error.code}: ${res.error.message}` };
      return {
        ok: true,
        value: res.value
          .filter((o) => loopTokens.includes(o.asset_id))
          .map((o) => ({
            orderId: o.id,
            tokenId: o.asset_id,
            price: Number(o.price),
            originalSize: Number(o.original_size),
            sizeMatched: Number(o.size_matched),
          })),
      };
    },

    async mergeState(transactionId) {
      const res = await deps.relayer.getTransactionState(deps.owner, transactionId);
      if (!res.ok) return { ok: false, message: `${res.error.code}: ${res.error.message}` };
      const state = res.value.state;
      if (isDepositWalletConfirmed(state)) return { ok: true, value: "confirmed" };
      if (state === "STATE_FAILED" || state === "STATE_INVALID") {
        return { ok: true, value: "failed" };
      }
      return { ok: true, value: "pending" };
    },
  };
};
