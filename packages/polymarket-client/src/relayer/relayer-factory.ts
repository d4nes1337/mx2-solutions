import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTxType, TransactionType } from "@polymarket/builder-relayer-client";
import { http, type Address, type Hex, type WalletClient } from "viem";
import { polygon } from "viem/chains";
import {
  createDepositWalletRelayer,
  createDisabledDepositWalletRelayer,
  type DepositWalletOwner,
  type DepositWalletRelayer,
} from "./deposit-wallet.js";

/**
 * Shared construction of the deposit-wallet relayer from configuration —
 * used by both the API (wallet activation, withdrawals, allowances) and the
 * worker (maker-loop merges) so the two processes can never drift in how
 * they talk to the relayer. Fail-closed: missing feature flag or builder
 * credentials yields the disabled relayer, never a partial client.
 *
 * Signing is injected as a structural bridge (typedData → signature) so this
 * package stays independent of the app's TradingSigner seam; the bridge must
 * THROW on failure.
 */
export interface RelayerTypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type RelayerSignerBridge = (
  owner: DepositWalletOwner,
  typedData: RelayerTypedDataPayload,
) => Promise<string>;

export interface DepositWalletRelayerFactoryOptions {
  enabled: boolean;
  relayerUrl?: string | undefined;
  builderApiKey?: string | undefined;
  builderSecret?: string | undefined;
  builderPassphrase?: string | undefined;
  chainId: number;
  polygonRpcUrl?: string | undefined;
  signTypedData: RelayerSignerBridge;
}

const unsupportedWalletMethod = (method: string): never => {
  throw new Error(`Relayer signer bridge does not support ${method}.`);
};

const toTypedData = (args: {
  domain?: unknown;
  types?: unknown;
  primaryType?: unknown;
  message?: unknown;
}): RelayerTypedDataPayload => ({
  domain: (args.domain ?? {}) as Record<string, unknown>,
  types: (args.types ?? {}) as RelayerTypedDataPayload["types"],
  primaryType: String(args.primaryType),
  message: (args.message ?? {}) as Record<string, unknown>,
});

const createBridgedWalletClient = (
  opts: DepositWalletRelayerFactoryOptions,
  owner: DepositWalletOwner,
): WalletClient => {
  if (!owner.ownerWalletId) {
    throw new Error("Deposit-wallet relayer requires a provisioned Privy wallet id.");
  }
  if (!opts.polygonRpcUrl) {
    throw new Error("Deposit-wallet relayer requires POLYGON_RPC_URL for SDK chain reads.");
  }
  if (opts.chainId !== polygon.id) {
    throw new Error("Deposit-wallet relayer is currently wired for Polygon mainnet (chainId 137).");
  }

  const address = owner.ownerAddress as Address;
  const chain = polygon;
  const transport = http(opts.polygonRpcUrl)({ chain });

  return {
    account: { address, type: "json-rpc" },
    chain,
    transport,
    requestAddresses: async () => [address],
    signTypedData: async (args: unknown) => {
      const typedData = toTypedData(args as Parameters<WalletClient["signTypedData"]>[0]);
      return (await opts.signTypedData(owner, typedData)) as Hex;
    },
    signMessage: async () => unsupportedWalletMethod("signMessage"),
    signTransaction: async () => unsupportedWalletMethod("signTransaction"),
    sendTransaction: async () => unsupportedWalletMethod("sendTransaction"),
  } as unknown as WalletClient;
};

export const createConfiguredDepositWalletRelayer = (
  opts: DepositWalletRelayerFactoryOptions,
): DepositWalletRelayer => {
  if (!opts.enabled) return createDisabledDepositWalletRelayer();
  if (!opts.relayerUrl || !opts.builderApiKey || !opts.builderSecret || !opts.builderPassphrase) {
    return createDisabledDepositWalletRelayer();
  }

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: opts.builderApiKey,
      secret: opts.builderSecret,
      passphrase: opts.builderPassphrase,
    },
  });

  return createDepositWalletRelayer({
    waitForConfirmation: false,
    // Deposit wallets are queried under the SDK's "WALLET" transaction-type
    // bucket (see executeDepositWalletBatch's getNonce call), not "PROXY"
    // (the relay-transport mode used by RelayClient's constructor below).
    // Passing PROXY here makes getDeployed() look up the wrong bucket and
    // return a false negative for an already-deployed wallet.
    transactionType: TransactionType.WALLET,
    clientForOwner: (owner) =>
      new RelayClient(
        opts.relayerUrl!,
        opts.chainId,
        createBridgedWalletClient(opts, owner),
        builderConfig,
        RelayerTxType.PROXY,
        { chain: polygon },
      ),
  });
};
