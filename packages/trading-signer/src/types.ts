import type { Result } from "@mx2/core";

/**
 * The signing seam. Both the manual order route (apps/api) and the conditional
 * rule worker (apps/worker) depend ONLY on this interface — never on a concrete
 * wallet provider — so signing is identical across paths, fully mockable in tests,
 * and the provider (Privy) is swappable.
 *
 * Security invariant: a TradingSigner NEVER exposes or holds a raw private key.
 * The production adapter delegates to Privy, which signs inside a secure enclave.
 */

/** EIP-712 typed data in eth_signTypedData_v4-compatible JSON shape. */
export interface Eip712TypedData {
  primaryType: string;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export type SignerErrorCode =
  | "NETWORK_ERROR"
  | "POLICY_DENIED"
  | "DELEGATION_EXPIRED"
  | "UNAUTHORIZED"
  | "NOT_PROVISIONED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export interface SignerError {
  code: SignerErrorCode;
  message: string;
  cause?: unknown;
}

/** Reference to a Privy-managed embedded wallet. Holds NO key material. */
export interface TradingWalletRef {
  /** Privy wallet id — used for all signing/transaction calls. */
  walletId: string;
  /** The embedded EOA address that owns/signs for the Polymarket deposit wallet. */
  address: string;
}

export interface SignTypedDataRequest {
  wallet: TradingWalletRef;
  typedData: Eip712TypedData;
}

export interface SendTransactionRequest {
  wallet: TradingWalletRef;
  /** Target contract address. Restricted to the Polymarket allowlist by Privy policy. */
  to: string;
  /** Encoded calldata (0x...). */
  data: string;
  /** Optional value in hex wei (default 0). */
  value?: string;
}

export interface TradingSigner {
  /** Provision a new embedded trading wallet for a user. */
  provisionWallet(userRef: string): Promise<Result<TradingWalletRef, SignerError>>;
  /**
   * Check whether an embedded wallet still exists at the provider.
   * ok("not_found") is a DEFINITIVE provider answer (safe to heal from);
   * transient failures come back as err(...) and must never trigger
   * destructive cleanup of the wallet mapping.
   */
  getWalletStatus(walletId: string): Promise<Result<"active" | "not_found", SignerError>>;
  /** Sign a CTF Exchange Order (EIP-712). */
  signOrder(req: SignTypedDataRequest): Promise<Result<{ signature: string }, SignerError>>;
  /** Sign the L1 ClobAuth message (EIP-712) for L2 credential derivation. */
  signClobAuth(req: SignTypedDataRequest): Promise<Result<{ signature: string }, SignerError>>;
  /** Submit an on-chain transaction (allowance bootstrap) under Privy policy. */
  sendTransaction(req: SendTransactionRequest): Promise<Result<{ txHash: string }, SignerError>>;
}
