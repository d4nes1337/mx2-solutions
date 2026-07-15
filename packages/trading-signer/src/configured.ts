import { err } from "@mx2/core";
import { createMockTradingSigner } from "./mock-adapter.js";
import { createPrivyTradingSigner } from "./privy-adapter.js";
import { createRealPrivyClient, type RealPrivyClientConfig } from "./privy-client.js";
import type { TradingSigner, SignerError } from "./types.js";

/**
 * Selects the signing backend from config-derived flags. Shared by the API
 * (manual orders) and the worker (auto-execution) so both choose identically:
 *  - disabled → a signer that fails closed if ever called (server-side signing off),
 *  - non-production + a mock key → local-key mock (the live-OFF dry-run),
 *  - otherwise → the real Privy adapter backed by `@privy-io/node`.
 */
export interface TradingSignerConfig {
  /** FEATURE_PRIVY_SIGNING. */
  enabled: boolean;
  isProduction: boolean;
  /** Non-production only: a throwaway key for the mock signer (dry-run). */
  mockSignerPrivateKey?: string | undefined;
  /** Privy credentials; when present (and no mock key), the real signer is used. */
  privy?: RealPrivyClientConfig | undefined;
}

const disabledError: SignerError = {
  code: "INTERNAL_ERROR",
  message: "Trading signer is not configured (server-side signing is disabled).",
};

const createDisabledSigner = (): TradingSigner => ({
  provisionWallet: async () => err(disabledError),
  getWalletStatus: async () => err(disabledError),
  signOrder: async () => err(disabledError),
  signClobAuth: async () => err(disabledError),
  sendTransaction: async () => err(disabledError),
});

export const createConfiguredTradingSigner = (cfg: TradingSignerConfig): TradingSigner => {
  if (!cfg.enabled) return createDisabledSigner();
  // Mock takes precedence in non-production so the dry-run never touches Privy.
  if (cfg.mockSignerPrivateKey && !cfg.isProduction) {
    return createMockTradingSigner({ privateKey: cfg.mockSignerPrivateKey as `0x${string}` });
  }
  if (cfg.privy) {
    return createPrivyTradingSigner(createRealPrivyClient(cfg.privy));
  }
  throw new Error(
    "FEATURE_PRIVY_SIGNING is on but no signer backend is configured (need Privy creds, " +
      "or MOCK_SIGNER_PRIVATE_KEY in a non-production env).",
  );
};
