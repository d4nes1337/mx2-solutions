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

/**
 * Provider-side health of the mapped wallet as observed during this call.
 * "unknown" means verification failed transiently — we re-linked without
 * verifying rather than blocking the user or destroying anything.
 */
export type TradingWalletHealth = "ok" | "unknown";

export interface ProvisionWalletResult {
  ok: true;
  tradingAccountId: string;
  embeddedAddress: string;
  depositWalletAddress: string | null;
  allowancesBootstrapped: boolean;
  alreadyProvisioned: boolean;
  /** True when a provider-side-deleted wallet was detected and replaced. */
  reissued: boolean;
  walletHealth: TradingWalletHealth;
}

export interface ProvisionWalletFailure {
  ok: false;
  code: "PROVISION_FAILED";
  message: string;
}

/**
 * Idempotently ensure the user has a Privy-managed embedded trading wallet plus
 * the matching internal trading account. Safe to call repeatedly, and
 * SELF-HEALING: when a stored mapping points at a wallet the provider says no
 * longer exists (e.g. it was deleted in the Privy dashboard), the ghost
 * account rows are archived and a fresh wallet is provisioned in its place.
 * Destructive cleanup only ever happens on a DEFINITIVE provider "not found" —
 * a transient verification failure re-links the existing mapping untouched.
 * Shared by the explicit `/provision` + `/reissue` endpoints and the automatic
 * provisioning that runs on login so every user is trade-ready from the start.
 */
export const ensureTradingWalletProvisioned = async (
  deps: ProvisionWalletDeps,
  ownerWalletAddress: string,
): Promise<ProvisionWalletResult | ProvisionWalletFailure> => {
  const existing = await deps.privyWallets.find(ownerWalletAddress);
  let reissued = false;

  if (existing) {
    const status = await deps.tradingSigner.getWalletStatus(existing.privyWalletId);

    if (!status.ok || status.value === "active") {
      // Alive — or unverifiable right now. Either way: re-link, never recreate.
      // If the account row was soft-deleted in the app ("Remove wallet"), the
      // upsert restores it — the wallet itself (address, funds) never left.
      const account = await deps.tradingAccounts.upsertInternalPrivy({
        ownerWalletAddress,
        signerAddress: existing.embeddedAddress,
        privyWalletId: existing.privyWalletId,
        status: "needs_deposit_wallet",
        makePrimary: false,
        metadata: { source: "privy_existing", relayerRequired: true },
      });
      if (account.wasArchived) {
        await deps.auditStore.emit({
          actor: ownerWalletAddress,
          action: "trading_account.unarchived",
          subject: `wallet:${ownerWalletAddress}`,
          metadata: {
            tradingAccountId: account.id,
            embeddedAddress: existing.embeddedAddress,
          },
        });
      }
      return {
        ok: true,
        tradingAccountId: account.id,
        embeddedAddress: existing.embeddedAddress,
        depositWalletAddress: account.depositWalletAddress,
        allowancesBootstrapped: existing.allowancesBootstrappedAt !== null,
        alreadyProvisioned: true,
        reissued: false,
        walletHealth: status.ok ? "ok" : "unknown",
      };
    }

    // Definitive provider 404: the wallet was deleted outside the app. Record
    // the ghost, then fall through to fresh provisioning. The stale mapping is
    // only overwritten AFTER the new wallet exists, so a failed provision
    // leaves the previous state (and audit trail) fully intact.
    await deps.auditStore.emit({
      actor: ownerWalletAddress,
      action: "trading_wallet.ghost_detected",
      subject: `wallet:${ownerWalletAddress}`,
      metadata: {
        privyWalletId: existing.privyWalletId,
        embeddedAddress: existing.embeddedAddress,
      },
    });
    reissued = true;
  }

  const provisioned = await deps.tradingSigner.provisionWallet(ownerWalletAddress);
  if (!provisioned.ok) {
    return { ok: false, code: "PROVISION_FAILED", message: provisioned.error.message };
  }

  if (existing) {
    // Archive every account still pointing at the dead wallet (its deposit
    // wallet is unreachable without the old signer). archive() also promotes
    // the next active account to primary when needed.
    const accounts = await deps.tradingAccounts.listByOwner(ownerWalletAddress);
    for (const account of accounts) {
      if (account.kind === "internal_privy" && account.privyWalletId === existing.privyWalletId) {
        await deps.tradingAccounts.archive(ownerWalletAddress, account.id);
      }
    }
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
    metadata: { source: reissued ? "privy_reissue" : "privy_provision", relayerRequired: true },
  });

  await deps.auditStore.emit({
    actor: ownerWalletAddress,
    action: reissued ? "trading_wallet.reissued" : "trading_wallet.provisioned",
    subject: `wallet:${ownerWalletAddress}`,
    metadata: {
      embeddedAddress: row.embeddedAddress,
      policyId: row.policyId,
      tradingAccountId: account.id,
      ...(reissued && existing ? { replacedPrivyWalletId: existing.privyWalletId } : {}),
    },
  });

  return {
    ok: true,
    tradingAccountId: account.id,
    embeddedAddress: row.embeddedAddress,
    depositWalletAddress: account.depositWalletAddress,
    allowancesBootstrapped: false,
    alreadyProvisioned: false,
    reissued,
    walletHealth: "ok",
  };
};
