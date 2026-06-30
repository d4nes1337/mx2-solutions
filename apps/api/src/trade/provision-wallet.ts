import type { AppConfig } from "@mx2/config";
import type { AuditStore, PrivyWalletStore, TradingAccountStore } from "@mx2/db";
import type { TradingSigner } from "@mx2/trading-signer";

export interface ProvisionWalletDeps {
  config: AppConfig;
  auditStore: AuditStore;
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  tradingAccounts: TradingAccountStore;
}

export interface ProvisionWalletResult {
  ok: true;
  tradingAccountId: string;
  embeddedAddress: string;
  depositWalletAddress: string | null;
  allowancesBootstrapped: boolean;
  alreadyProvisioned: boolean;
}

export interface ProvisionWalletFailure {
  ok: false;
  code: "PROVISION_FAILED";
  message: string;
}

/**
 * Idempotently ensure the user has a Privy-managed embedded trading wallet plus the
 * matching internal trading account. Safe to call repeatedly: an existing wallet is
 * re-linked rather than recreated. Shared by the explicit `/provision` endpoint and the
 * automatic provisioning that runs on login so every user is trade-ready from the start.
 */
export const ensureTradingWalletProvisioned = async (
  deps: ProvisionWalletDeps,
  ownerWalletAddress: string,
): Promise<ProvisionWalletResult | ProvisionWalletFailure> => {
  const existing = await deps.privyWallets.find(ownerWalletAddress);
  if (existing) {
    const account = await deps.tradingAccounts.upsertInternalPrivy({
      ownerWalletAddress,
      signerAddress: existing.embeddedAddress,
      privyWalletId: existing.privyWalletId,
      status: "needs_deposit_wallet",
      makePrimary: false,
      metadata: { source: "privy_existing", relayerRequired: true },
    });
    return {
      ok: true,
      tradingAccountId: account.id,
      embeddedAddress: existing.embeddedAddress,
      depositWalletAddress: account.depositWalletAddress,
      allowancesBootstrapped: existing.allowancesBootstrappedAt !== null,
      alreadyProvisioned: true,
    };
  }

  const provisioned = await deps.tradingSigner.provisionWallet(ownerWalletAddress);
  if (!provisioned.ok) {
    return { ok: false, code: "PROVISION_FAILED", message: provisioned.error.message };
  }

  const row = await deps.privyWallets.upsert({
    walletAddress: ownerWalletAddress,
    privyUserId: ownerWalletAddress,
    privyWalletId: provisioned.value.walletId,
    embeddedAddress: provisioned.value.address,
    policyId: deps.config.privy.tradingPolicyId ?? null,
  });
  const account = await deps.tradingAccounts.upsertInternalPrivy({
    ownerWalletAddress,
    signerAddress: row.embeddedAddress,
    privyWalletId: row.privyWalletId,
    status: "needs_deposit_wallet",
    makePrimary: false,
    metadata: { source: "privy_provision", relayerRequired: true },
  });

  await deps.auditStore.emit({
    actor: ownerWalletAddress,
    action: "trading_wallet.provisioned",
    subject: `wallet:${ownerWalletAddress}`,
    metadata: {
      embeddedAddress: row.embeddedAddress,
      policyId: row.policyId,
      tradingAccountId: account.id,
    },
  });

  return {
    ok: true,
    tradingAccountId: account.id,
    embeddedAddress: row.embeddedAddress,
    depositWalletAddress: account.depositWalletAddress,
    allowancesBootstrapped: false,
    alreadyProvisioned: false,
  };
};
