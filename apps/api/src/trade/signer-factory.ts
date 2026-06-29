import type { AppConfig } from "@mx2/config";
import {
  createConfiguredTradingSigner,
  type TradingSigner,
  type TradingSignerConfig,
} from "@mx2/trading-signer";

/** Maps AppConfig to the shared signer config (Privy creds → real signer). */
export const toTradingSignerConfig = (config: AppConfig): TradingSignerConfig => {
  const p = config.privy;
  const privy =
    p.appId && p.appSecret && p.authorizationKey
      ? {
          appId: p.appId,
          appSecret: p.appSecret,
          authorizationPrivateKey: p.authorizationKey,
          keyQuorumId: p.keyQuorumId,
          tradingPolicyId: p.tradingPolicyId,
          rpcUrl: config.polygonRpcUrl,
        }
      : undefined;
  return {
    enabled: config.features.privySigning,
    isProduction: config.env === "production",
    mockSignerPrivateKey: config.mockSignerPrivateKey,
    privy,
  };
};

export const createTradingSignerFromConfig = (config: AppConfig): TradingSigner =>
  createConfiguredTradingSigner(toTradingSignerConfig(config));
