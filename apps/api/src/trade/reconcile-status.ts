import { PUSD_ADDRESS } from "@mx2/polymarket-client";
import type { TradingAccountStore } from "@mx2/db";
import type { AllowanceReader } from "./allowance-bootstrap.js";

/**
 * Wallet status is otherwise a stale snapshot written once at activation. This
 * reconciles an internal (Privy) trading account against on-chain reality so the
 * UI stops nagging incorrectly:
 *   - no deposit wallet            → needs_deposit_wallet (must activate)
 *   - deposit wallet, balance 0    → needs_funding
 *   - deposit wallet, pUSD funded  → needs_delegation (funded; authorize is the
 *                                    optional next step for no-popup trading)
 *
 * Forward-only and fail-safe: it never walks a further-along account backwards
 * (delegation/credentials/ready are left untouched), and when the balance can't
 * be read it returns the stored status unchanged. Polymarket deposit wallets are
 * counterfactual — the address receives funds before the proxy is mined — so a
 * present deposit-wallet address is treated as "activated".
 */

/** pUSD (6-decimals) at/above which a deposit wallet counts as funded (~$0.50). */
export const FUNDED_THRESHOLD_RAW = 500_000n;

/** Statuses at/after "funded" that reconciliation must never regress. */
const ADVANCED = new Set(["needs_delegation", "needs_credentials", "ready", "disabled"]);

export const reconcileInternalStatus = (
  account: { status: string; depositWalletAddress: string | null },
  depositPusdRaw: bigint | null,
): string => {
  if (!account.depositWalletAddress) return "needs_deposit_wallet";
  // Already funded/authorized/ready — leave it; also nothing to gain from a read.
  if (ADVANCED.has(account.status)) return account.status;
  // Balance unknown (no RPC / read failed) — trust the stored status.
  if (depositPusdRaw === null) return account.status;
  if (depositPusdRaw >= FUNDED_THRESHOLD_RAW) return "needs_delegation";
  // Has a deposit wallet but not funded yet: at least "needs_funding", never
  // back to "needs_deposit_wallet" (the address exists and can receive funds).
  return "needs_funding";
};

/**
 * Reconcile + persist forward promotions for one internal account. Does a single
 * pUSD balance read only when it could change the outcome (skips advanced/ready
 * accounts and the no-reader case). Returns the effective status to serialize.
 */
export const reconcileAndPersist = async (
  account: { id: string; kind: string; status: string; depositWalletAddress: string | null },
  reader: AllowanceReader | null,
  store: Pick<TradingAccountStore, "updateStatus">,
): Promise<string> => {
  if (account.kind !== "internal_privy") return account.status;
  if (!account.depositWalletAddress) return account.status;
  if (ADVANCED.has(account.status)) return account.status;
  if (!reader) return account.status;

  let depositPusdRaw: bigint | null = null;
  try {
    depositPusdRaw = await reader.erc20Balance(PUSD_ADDRESS, account.depositWalletAddress);
  } catch {
    return account.status; // fail-safe: keep stored status on RPC error
  }

  const next = reconcileInternalStatus(account, depositPusdRaw);
  if (next !== account.status) await store.updateStatus(account.id, next as never);
  return next;
};
