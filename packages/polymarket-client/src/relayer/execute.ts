import { err, ok, type Result } from "@mx2/core";
import type {
  DepositWalletOwner,
  DepositWalletRelayerError,
  RelayerTransactionResponseLike,
} from "./deposit-wallet.js";

/**
 * Gasless transaction execution through Polymarket's builder relayer
 * (relayer-v2.polymarket.com) — the path CTF merges take (RFC-0003; verified
 * against @polymarket/builder-relayer-client docs 2026-07-15, INTEGRATION
 * §16). Mirrors the deposit-wallet seam: the caller injects a per-owner SDK
 * client so signer interop stays isolated, and a disabled variant exists for
 * every configuration that hasn't been staging-verified.
 */

export interface RelayerTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: string;
}

export interface RelayerExecuteResult {
  transactionId: string;
  state: string;
  transactionHash?: string;
}

export interface TransactionRelayerClient {
  execute(txs: RelayerTransaction[], description?: string): Promise<RelayerTransactionResponseLike>;
}

export interface TransactionRelayer {
  readonly enabled: boolean;
  execute(
    owner: DepositWalletOwner,
    txs: RelayerTransaction[],
    description?: string,
  ): Promise<Result<RelayerExecuteResult, DepositWalletRelayerError>>;
}

export interface TransactionRelayerOptions {
  clientForOwner(owner: DepositWalletOwner): TransactionRelayerClient;
  waitForConfirmation?: boolean;
}

const disabledError: DepositWalletRelayerError = {
  code: "RELAYER_DISABLED",
  message:
    "The Polymarket transaction relayer is not configured. Enable FEATURE_RELAYER with relayer credentials first.",
};

export const createDisabledTransactionRelayer = (): TransactionRelayer => ({
  enabled: false,
  execute: async () => err(disabledError),
});

export const createTransactionRelayer = (opts: TransactionRelayerOptions): TransactionRelayer => ({
  enabled: true,
  async execute(owner, txs, description) {
    try {
      const client = opts.clientForOwner(owner);
      const submitted = await client.execute(txs, description);
      let state = submitted.state;
      let transactionHash = submitted.transactionHash ?? submitted.hash;
      if (opts.waitForConfirmation && submitted.wait) {
        const confirmed = await submitted.wait();
        state = confirmed?.state ?? state;
        transactionHash = confirmed?.transactionHash ?? transactionHash;
      }
      const value: RelayerExecuteResult = { transactionId: submitted.transactionID, state };
      if (transactionHash) value.transactionHash = transactionHash;
      return ok(value);
    } catch (cause) {
      return err({
        code: "RELAYER_UPSTREAM_ERROR",
        message: "Relayer transaction submission failed.",
        cause,
      });
    }
  },
});
