import { decryptCredentials } from "@mx2/core";
import type { AppConfig } from "@mx2/config";
import type {
  PrivyWalletStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import type {
  AuthenticatedClobClient,
  DepositWalletRelayer,
  L2Credentials,
} from "@mx2/polymarket-client";
import type { TradingSigner } from "@mx2/trading-signer";
import {
  createShadowExecutor,
  type ExecutorResolution,
  type QuoterExecutorProvider,
  type QuoterLoopContext,
} from "./executor.js";
import { createLiveExecutor } from "./live-executor.js";

/**
 * Resolves the per-cycle executor for a maker loop. Shadow always works;
 * confirm/live sessions get a REAL executor only when every W2–W4
 * prerequisite resolves — anything missing surfaces as `unavailable`, which
 * the manager turns into a visible session halt (fail-closed; RFC-0003
 * "never silently shadow a live session").
 */
export interface LiveCapableProviderDeps {
  config: AppConfig;
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  depositWalletRelayer: DepositWalletRelayer;
  tradingClobClient: AuthenticatedClobClient;
}

export const createLiveCapableProvider = (
  deps: LiveCapableProviderDeps,
): QuoterExecutorProvider => {
  const shadow = createShadowExecutor();

  const resolveLive = async (ctx: QuoterLoopContext): Promise<ExecutorResolution> => {
    if (!deps.config.features.makerLoopLive) return { unavailable: "maker_loop_live_disabled" };
    const masterKey = deps.config.encryptionMasterKey;
    if (!masterKey) return { unavailable: "no_master_key" };
    if (!deps.config.features.relayer || !deps.depositWalletRelayer.enabled) {
      return { unavailable: "relayer_disabled" };
    }

    const pw = await deps.privyWallets.find(ctx.walletAddress);
    if (!pw) return { unavailable: "wallet_not_provisioned" };
    const accounts = await deps.tradingAccounts.listByOwner(ctx.walletAddress);
    const account = accounts.find(
      (a) =>
        a.kind === "internal_privy" &&
        a.archivedAt === null &&
        a.privyWalletId !== null &&
        a.depositWalletAddress !== null &&
        a.signerAddress.toLowerCase() === pw.embeddedAddress.toLowerCase(),
    );
    if (!account?.depositWalletAddress || !account.privyWalletId) {
      return { unavailable: "deposit_wallet_required" };
    }

    const credsRow = await deps.accountClobCredentials.find(account.id);
    if (!credsRow) return { unavailable: "clob_credentials_missing" };
    let creds: L2Credentials;
    try {
      creds = decryptCredentials<L2Credentials>(
        credsRow.encryptedCreds as Parameters<typeof decryptCredentials>[0],
        masterKey,
      );
    } catch {
      return { unavailable: "clob_credentials_unreadable" };
    }

    const adapterAddress = ctx.market.negRisk
      ? deps.config.ctf.negRiskAdapterAddress
      : deps.config.ctf.adapterAddress;
    if (!adapterAddress) return { unavailable: "ctf_adapter_unverified" };

    const walletRef = { walletId: account.privyWalletId, address: account.signerAddress };
    return {
      executor: createLiveExecutor({
        ctx,
        clobClient: deps.tradingClobClient,
        creds,
        signerAddress: account.signerAddress,
        depositWalletAddress: account.depositWalletAddress,
        sign: async (payload) => {
          const r = await deps.tradingSigner.signOrder({ wallet: walletRef, typedData: payload });
          if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
          return r.value.signature;
        },
        relayer: deps.depositWalletRelayer,
        owner: { ownerAddress: pw.embeddedAddress, ownerWalletId: pw.privyWalletId },
        adapterAddress,
      }),
    };
  };

  return {
    async forLoop(ctx, sessionMode) {
      if (sessionMode === "shadow") return { executor: shadow };
      return resolveLive(ctx);
    },
  };
};
