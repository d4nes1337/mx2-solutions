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

const confirmedStates = new Set<RelayerTransactionState>(["STATE_MINED", "STATE_CONFIRMED"]);

export const isDepositWalletConfirmed = (state: RelayerTransactionState | undefined): boolean =>
  state ? confirmedStates.has(state) : false;

export const createDisabledDepositWalletRelayer = (): DepositWalletRelayer => ({
  enabled: false,
  deriveDepositWalletAddress: async () => err(disabledError),
  getDeploymentStatus: async () => err(disabledError),
  deployDepositWallet: async () => err(disabledError),
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
        return err(toError("Could not submit Polymarket deposit-wallet deployment.", cause));
      }
    },
  };
};
