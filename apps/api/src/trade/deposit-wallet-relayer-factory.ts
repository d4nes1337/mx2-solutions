import type { AppConfig } from "@mx2/config";
import {
  createConfiguredDepositWalletRelayer,
  type DepositWalletRelayer,
} from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";

/**
 * API-side adapter over the shared relayer factory: binds the app config and
 * bridges relayer typed-data signing (plain EIP-712 `DepositWallet` Batch
 * auth) into the TradingSigner seam, so the raw key stays in Privy's enclave.
 */
export const createDepositWalletRelayerFromConfig = (
  cfg: AppConfig,
  tradingSigner: TradingSigner,
): DepositWalletRelayer =>
  createConfiguredDepositWalletRelayer({
    enabled: cfg.features.relayer,
    relayerUrl: cfg.polymarket.relayer.url,
    builderApiKey: cfg.polymarket.relayer.builderApiKey,
    builderSecret: cfg.polymarket.relayer.builderSecret,
    builderPassphrase: cfg.polymarket.relayer.builderPassphrase,
    chainId: cfg.polymarket.chainId,
    polygonRpcUrl: cfg.polygonRpcUrl,
    signTypedData: async (owner, typedData) => {
      if (!owner.ownerWalletId) {
        throw new Error("Deposit-wallet relayer requires a provisioned Privy wallet id.");
      }
      const signed = await tradingSigner.signOrder({
        wallet: { walletId: owner.ownerWalletId, address: owner.ownerAddress },
        typedData,
      });
      if (!signed.ok) throw new Error(signed.error.message);
      return signed.value.signature;
    },
  });
