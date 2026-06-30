import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import type { AppConfig } from "@mx2/config";
import {
  createDepositWalletRelayer,
  createDisabledDepositWalletRelayer,
  type DepositWalletOwner,
  type DepositWalletRelayer,
} from "@mx2/polymarket-client";
import type { Eip712TypedData, TradingSigner } from "@mx2/trading-signer";
import { http, type Address, type Hex, type WalletClient } from "viem";
import { polygon } from "viem/chains";

const unsupportedWalletMethod = (method: string): never => {
  throw new Error(`Relayer signer bridge does not support ${method}.`);
};

const toTypedData = (args: {
  domain?: unknown;
  types?: unknown;
  primaryType?: unknown;
  message?: unknown;
}): Eip712TypedData => ({
  domain: (args.domain ?? {}) as Record<string, unknown>,
  types: (args.types ?? {}) as Eip712TypedData["types"],
  primaryType: String(args.primaryType),
  message: (args.message ?? {}) as Record<string, unknown>,
});

const createPrivyBackedWalletClient = (
  cfg: AppConfig,
  tradingSigner: TradingSigner,
  owner: DepositWalletOwner,
): WalletClient => {
  if (!owner.ownerWalletId) {
    throw new Error("Deposit-wallet relayer requires a provisioned Privy wallet id.");
  }
  if (!cfg.polygonRpcUrl) {
    throw new Error("Deposit-wallet relayer requires POLYGON_RPC_URL for SDK chain reads.");
  }
  if (cfg.polymarket.chainId !== polygon.id) {
    throw new Error("Deposit-wallet relayer is currently wired for Polygon mainnet (chainId 137).");
  }

  const address = owner.ownerAddress as Address;
  const chain = polygon;
  const transport = http(cfg.polygonRpcUrl)({ chain });
  const walletRef = { walletId: owner.ownerWalletId, address: owner.ownerAddress };

  return {
    account: { address, type: "json-rpc" },
    chain,
    transport,
    requestAddresses: async () => [address],
    signTypedData: async (args: unknown) => {
      const typedData = toTypedData(args as Parameters<WalletClient["signTypedData"]>[0]);
      const signed = await tradingSigner.signOrder({ wallet: walletRef, typedData });
      if (!signed.ok) throw new Error(signed.error.message);
      return signed.value.signature as Hex;
    },
    signMessage: async () => unsupportedWalletMethod("signMessage"),
    signTransaction: async () => unsupportedWalletMethod("signTransaction"),
    sendTransaction: async () => unsupportedWalletMethod("sendTransaction"),
  } as unknown as WalletClient;
};

export const createDepositWalletRelayerFromConfig = (
  cfg: AppConfig,
  tradingSigner: TradingSigner,
): DepositWalletRelayer => {
  if (!cfg.features.relayer) return createDisabledDepositWalletRelayer();

  const relayerUrl = cfg.polymarket.relayer.url;
  const builderApiKey = cfg.polymarket.relayer.builderApiKey;
  const builderSecret = cfg.polymarket.relayer.builderSecret;
  const builderPassphrase = cfg.polymarket.relayer.builderPassphrase;
  if (!relayerUrl || !builderApiKey || !builderSecret || !builderPassphrase) {
    return createDisabledDepositWalletRelayer();
  }

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: builderApiKey,
      secret: builderSecret,
      passphrase: builderPassphrase,
    },
  });

  return createDepositWalletRelayer({
    waitForConfirmation: false,
    transactionType: RelayerTxType.PROXY,
    clientForOwner: (owner) =>
      new RelayClient(
        relayerUrl,
        cfg.polymarket.chainId,
        createPrivyBackedWalletClient(cfg, tradingSigner, owner),
        builderConfig,
        RelayerTxType.PROXY,
        { chain: polygon },
      ),
  });
};
