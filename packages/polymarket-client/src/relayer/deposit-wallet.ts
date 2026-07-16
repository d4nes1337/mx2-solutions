import { err, ok, type Result } from "@mx2/core";

export type DepositWalletRelayerErrorCode =
  | "RELAYER_DISABLED"
  | "RELAYER_CONFIG_MISSING"
  | "RELAYER_UPSTREAM_ERROR";

export interface DepositWalletRelayerError {
  code: DepositWalletRelayerErrorCode;
  message: string;
  cause?: unknown;
}

export interface DepositWalletOwner {
  /** The EOA that owns/signs for the Polymarket deposit wallet. */
  ownerAddress: string;
  /** Provider-specific wallet id for server-side signing, when needed. */
  ownerWalletId?: string;
}

export interface DepositWalletAddressResult {
  ownerAddress: string;
  depositWalletAddress: string;
}

export type RelayerTransactionState =
  | "STATE_NEW"
  | "STATE_EXECUTED"
  | "STATE_MINED"
  | "STATE_INVALID"
  | "STATE_CONFIRMED"
  | "STATE_FAILED"
  | string;

export interface DepositWalletDeploymentStatus {
  ownerAddress: string;
  depositWalletAddress: string;
  deployed: boolean;
  state?: RelayerTransactionState;
  transactionId?: string;
  transactionHash?: string;
}

export interface DepositWalletDeploymentResult extends DepositWalletDeploymentStatus {
  submitted: boolean;
}

/** One call executed FROM the deposit wallet (SDK `DepositWalletCall`). */
export interface DepositWalletBatchCall {
  target: string;
  value: string;
  data: string;
}

export interface DepositWalletBatchResult {
  depositWalletAddress: string;
  transactionId: string;
  state: RelayerTransactionState;
  transactionHash?: string;
}

export interface DepositWalletRelayer {
  readonly enabled: boolean;
  deriveDepositWalletAddress(
    owner: DepositWalletOwner,
  ): Promise<Result<DepositWalletAddressResult, DepositWalletRelayerError>>;
  getDeploymentStatus(
    owner: DepositWalletOwner,
  ): Promise<Result<DepositWalletDeploymentStatus, DepositWalletRelayerError>>;
  deployDepositWallet(
    owner: DepositWalletOwner,
  ): Promise<Result<DepositWalletDeploymentResult, DepositWalletRelayerError>>;
  /**
   * Execute arbitrary calldata FROM the deposit wallet (gasless; authorized by
   * a plain EIP-712 `DepositWallet` Batch signature from the owner's signer —
   * INTEGRATION §4). The primitive behind withdrawals (USDC transfer to the
   * owner), relayer allowance batches (W2) and CTF merges (maker loop).
   */
  executeBatch(
    owner: DepositWalletOwner,
    calls: DepositWalletBatchCall[],
    opts?: { deadlineSeconds?: number },
  ): Promise<Result<DepositWalletBatchResult, DepositWalletRelayerError>>;
  /** Poll a previously submitted relayer transaction. */
  getTransactionState(
    owner: DepositWalletOwner,
    transactionId: string,
  ): Promise<
    Result<{ state: RelayerTransactionState; transactionHash?: string }, DepositWalletRelayerError>
  >;
}

export interface RelayerTransactionResponseLike {
  transactionID: string;
  state: string;
  transactionHash?: string;
  hash?: string;
  wait?: () => Promise<{ state?: string; transactionHash?: string } | undefined>;
}

export interface DepositWalletRelayerClient {
  deriveDepositWalletAddress(): Promise<string>;
  getDeployed(address: string, type?: string): Promise<boolean | { deployed: boolean }>;
  deployDepositWallet(): Promise<RelayerTransactionResponseLike>;
  executeDepositWalletBatch(
    calls: DepositWalletBatchCall[],
    walletAddress: string,
    deadline: string,
  ): Promise<RelayerTransactionResponseLike>;
  getTransaction(
    transactionId: string,
  ): Promise<Array<{ state?: string; transactionHash?: string }>>;
}

export interface DepositWalletRelayerOptions {
  clientForOwner(owner: DepositWalletOwner): DepositWalletRelayerClient;
  transactionType?: string;
  waitForConfirmation?: boolean;
}

const disabledError: DepositWalletRelayerError = {
  code: "RELAYER_DISABLED",
  message:
    "Polymarket deposit-wallet relayer is not configured. Enable FEATURE_RELAYER after builder credentials and signer bridge are ready.",
};

const toError = (message: string, cause: unknown): DepositWalletRelayerError => ({
  code: "RELAYER_UPSTREAM_ERROR",
  message,
  cause,
});

/**
 * The relayer rejects a redundant deploy with a 4xx body like
 * `{ "error": "wallet already deployed" }`. Our own deployment-status check
 * should already filter this out, but treat it as success defensively in
 * case of upstream indexing lag rather than surfacing a hard failure.
 */
const isAlreadyDeployedError = (cause: unknown): boolean => {
  const data = (cause as { data?: { error?: unknown } } | undefined)?.data;
  const message = typeof data?.error === "string" ? data.error : undefined;
  return typeof message === "string" && message.toLowerCase().includes("already deployed");
};

const confirmedStates = new Set<RelayerTransactionState>(["STATE_MINED", "STATE_CONFIRMED"]);

export const isDepositWalletConfirmed = (state: RelayerTransactionState | undefined): boolean =>
  state ? confirmedStates.has(state) : false;

export const createDisabledDepositWalletRelayer = (): DepositWalletRelayer => ({
  enabled: false,
  deriveDepositWalletAddress: async () => err(disabledError),
  getDeploymentStatus: async () => err(disabledError),
  deployDepositWallet: async () => err(disabledError),
  executeBatch: async () => err(disabledError),
  getTransactionState: async () => err(disabledError),
});

/**
 * Thin adapter around Polymarket's official builder relayer client.
 *
 * The caller supplies a per-owner SDK client so the API route does not know
 * whether the signer is a native viem wallet, Ethers signer, or our Privy-backed
 * signer bridge. That keeps the risky SDK/signer interop isolated.
 */
export const createDepositWalletRelayer = (
  opts: DepositWalletRelayerOptions,
): DepositWalletRelayer => {
  const derive = async (
    owner: DepositWalletOwner,
  ): Promise<Result<DepositWalletAddressResult, DepositWalletRelayerError>> => {
    try {
      const client = opts.clientForOwner(owner);
      const depositWalletAddress = await client.deriveDepositWalletAddress();
      return ok({ ownerAddress: owner.ownerAddress, depositWalletAddress });
    } catch (cause) {
      return err(toError("Could not derive the Polymarket deposit wallet address.", cause));
    }
  };

  return {
    enabled: true,

    deriveDepositWalletAddress: derive,

    async getDeploymentStatus(owner) {
      const address = await derive(owner);
      if (!address.ok) return err(address.error);
      try {
        const client = opts.clientForOwner(owner);
        const deployed = await client.getDeployed(
          address.value.depositWalletAddress,
          opts.transactionType,
        );
        const deployedValue = typeof deployed === "boolean" ? deployed : deployed.deployed;
        return ok({
          ...address.value,
          deployed: deployedValue,
          state: deployedValue ? "STATE_CONFIRMED" : "STATE_NEW",
        });
      } catch (cause) {
        return err(toError("Could not read Polymarket deposit-wallet deployment status.", cause));
      }
    },

    async deployDepositWallet(owner) {
      const address = await derive(owner);
      if (!address.ok) return err(address.error);
      try {
        const client = opts.clientForOwner(owner);
        const submitted = await client.deployDepositWallet();
        let state: RelayerTransactionState = submitted.state;
        let transactionHash = submitted.transactionHash ?? submitted.hash;
        if (opts.waitForConfirmation && submitted.wait) {
          const confirmed = await submitted.wait();
          state = confirmed?.state ?? state;
          transactionHash = confirmed?.transactionHash ?? transactionHash;
        }
        const value: DepositWalletDeploymentResult = {
          ...address.value,
          deployed: isDepositWalletConfirmed(state),
          submitted: true,
          state,
          transactionId: submitted.transactionID,
        };
        if (transactionHash) value.transactionHash = transactionHash;
        return ok(value);
      } catch (cause) {
        if (isAlreadyDeployedError(cause)) {
          return ok({
            ...address.value,
            deployed: true,
            submitted: false,
            state: "STATE_CONFIRMED",
          });
        }
        return err(toError("Could not submit Polymarket deposit-wallet deployment.", cause));
      }
    },

    async executeBatch(owner, calls, batchOpts) {
      if (calls.length === 0) {
        return err(toError("Refusing to submit an empty deposit-wallet batch.", undefined));
      }
      const address = await derive(owner);
      if (!address.ok) return err(address.error);
      try {
        const client = opts.clientForOwner(owner);
        const deadline = String(
          Math.floor(Date.now() / 1000) + (batchOpts?.deadlineSeconds ?? 3_600),
        );
        const submitted = await client.executeDepositWalletBatch(
          calls,
          address.value.depositWalletAddress,
          deadline,
        );
        let state: RelayerTransactionState = submitted.state;
        let transactionHash = submitted.transactionHash ?? submitted.hash;
        if (opts.waitForConfirmation && submitted.wait) {
          const confirmed = await submitted.wait();
          state = confirmed?.state ?? state;
          transactionHash = confirmed?.transactionHash ?? transactionHash;
        }
        const value: DepositWalletBatchResult = {
          depositWalletAddress: address.value.depositWalletAddress,
          transactionId: submitted.transactionID,
          state,
        };
        if (transactionHash) value.transactionHash = transactionHash;
        return ok(value);
      } catch (cause) {
        return err(toError("Could not execute the deposit-wallet batch.", cause));
      }
    },

    async getTransactionState(owner, transactionId) {
      try {
        const client = opts.clientForOwner(owner);
        const rows = await client.getTransaction(transactionId);
        const row = rows?.[0];
        if (!row?.state) {
          return err(toError("Relayer returned no state for the transaction.", undefined));
        }
        const out: { state: RelayerTransactionState; transactionHash?: string } = {
          state: row.state,
        };
        if (row.transactionHash) out.transactionHash = row.transactionHash;
        return ok(out);
      } catch (cause) {
        return err(toError("Could not read the relayer transaction state.", cause));
      }
    },
  };
};
