import { getAddress } from "viem";
import type { FastifyInstance } from "fastify";
import type {
  AuditStore,
  SessionStore,
  TradingAccountStore,
  TradingAccountClobCredentialStore,
} from "@mx2/db";
import { deriveDepositWallet } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import type { AllowanceReader } from "../trade/allowance-bootstrap.js";
import { reconcileAndPersist } from "../trade/reconcile-status.js";

export interface TradingAccountsRoutesDeps {
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingAccounts: TradingAccountStore;
  accountClobCredentials: TradingAccountClobCredentialStore;
  /** null when POLYGON_RPC_URL is unset — status then falls back to stored value. */
  allowanceReader: AllowanceReader | null;
}

const toChecksum = (address: string): string => getAddress(address as `0x${string}`);

const deriveFunder = (address: string, override?: unknown): string => {
  if (typeof override === "string" && override.trim()) return toChecksum(override).toLowerCase();
  return deriveDepositWallet(address).toLowerCase();
};

const nextAction = (
  account: {
    status: string;
    signingMode: string;
    kind: string;
    funderAddress: string | null;
  },
  credentialsReady: boolean,
): string | null => {
  if (account.status === "ready" && credentialsReady) return null;
  if (account.kind === "internal_privy" && !account.funderAddress) return "activate_deposit_wallet";
  if (account.status === "needs_deposit_wallet") return "activate_deposit_wallet";
  if (account.status === "needs_funding") return "top_up";
  if (account.status === "needs_delegation") return "delegate";
  if (!credentialsReady) return "setup_credentials";
  return account.status;
};

export const registerTradingAccountsRoutes = (
  app: FastifyInstance,
  deps: TradingAccountsRoutesDeps,
): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const serializeAccount = async (
    account: Awaited<ReturnType<TradingAccountStore["listByOwner"]>>[number],
  ) => {
    const creds = await deps.accountClobCredentials.find(account.id);
    const credentialsReady = creds !== null;
    // Reconcile internal accounts against on-chain reality (deposit wallet +
    // pUSD balance) and persist forward promotions, so "needs activation"/
    // "needs funding" reflect the truth instead of a stale stored snapshot.
    const reconciledStatus = await reconcileAndPersist(
      account,
      deps.allowanceReader,
      deps.tradingAccounts,
    );
    const effective = { ...account, status: reconciledStatus };
    return {
      id: account.id,
      kind: account.kind,
      label: account.label,
      signerAddress: account.signerAddress,
      funderAddress: account.funderAddress,
      signatureType: account.signatureType,
      signingMode: account.signingMode,
      status:
        credentialsReady && reconciledStatus === "needs_credentials" ? "ready" : reconciledStatus,
      credentialsReady,
      isPrimary: account.isPrimary,
      depositWalletAddress: account.depositWalletAddress,
      nextAction: nextAction(effective, credentialsReady),
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    };
  };

  app.get("/api/trading-accounts", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const existing = await deps.tradingAccounts.listByOwner(user.walletAddress);
    const hasLoginWallet = existing.some(
      (a) => a.kind === "external_wallet" && a.signerAddress === user.walletAddress,
    );
    if (!hasLoginWallet) {
      await deps.tradingAccounts.upsertExternal({
        ownerWalletAddress: user.walletAddress,
        signerAddress: user.walletAddress,
        funderAddress: deriveFunder(user.walletAddress),
        label: "Connected Polymarket wallet",
        makePrimary: existing.length === 0,
        metadata: { source: "auto_login_wallet" },
      });
    }

    const accounts = await deps.tradingAccounts.listByOwner(user.walletAddress);
    const serialized = await Promise.all(accounts.map(serializeAccount));
    return {
      accounts: serialized,
      primaryAccount: serialized.find((a) => a.isPrimary) ?? serialized[0] ?? null,
    };
  });

  app.post("/api/trading-accounts/external", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawAddress = typeof body["address"] === "string" ? body["address"] : null;
    if (!rawAddress) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "address is required" };
    }

    let signerAddress: string;
    let funderAddress: string;
    try {
      signerAddress = toChecksum(rawAddress).toLowerCase();
      funderAddress = deriveFunder(signerAddress, body["funderAddress"]);
    } catch {
      reply.code(400);
      return { error: "INVALID_ADDRESS", message: "address or funderAddress is invalid" };
    }

    const label =
      typeof body["label"] === "string" && body["label"].trim()
        ? body["label"].trim().slice(0, 80)
        : "External Polymarket wallet";
    const makePrimary = body["makePrimary"] === true;

    const account = await deps.tradingAccounts.upsertExternal({
      ownerWalletAddress: user.walletAddress,
      signerAddress,
      funderAddress,
      label,
      makePrimary,
      metadata: { source: "user_added" },
    });
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_account.external_upserted" as const,
      subject: `trading_account:${account.id}`,
      metadata: { signerAddress, funderAddress, makePrimary },
    });

    return { account: await serializeAccount(account) };
  });

  app.post("/api/trading-accounts/:id/primary", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const params = req.params as { id: string };
    const account = await deps.tradingAccounts.setPrimary(user.walletAddress, params.id);
    if (!account) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trading account not found" };
    }
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_account.primary_set" as const,
      subject: `trading_account:${account.id}`,
      metadata: { kind: account.kind },
    });
    return { account: await serializeAccount(account) };
  });

  // ── DELETE /api/trading-accounts/:id ─────────────────────────────────────
  // Soft-delete: stamps archivedAt, hides the account from listing, and
  // auto-promotes the next active account to primary if needed.
  // The auto-login wallet (signerAddress === ownerWalletAddress) is blocked
  // from archival — it will just be re-created on next GET /api/trading-accounts.
  app.delete("/api/trading-accounts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const params = req.params as { id: string };

    const existing = await deps.tradingAccounts.findByOwner(user.walletAddress, params.id);
    if (!existing) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Trading account not found" };
    }
    if (existing.signerAddress === user.walletAddress.toLowerCase()) {
      reply.code(409);
      return {
        error: "CANNOT_ARCHIVE_LOGIN_WALLET",
        message:
          "The wallet you are signed in with cannot be removed — it is re-created automatically on login.",
      };
    }

    const archived = await deps.tradingAccounts.archive(user.walletAddress, params.id);
    if (!archived) {
      reply.code(409);
      return { error: "ALREADY_ARCHIVED", message: "Trading account is already archived." };
    }

    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_account.archived" as const,
      subject: `trading_account:${archived.id}`,
      metadata: { kind: archived.kind, signerAddress: archived.signerAddress },
    });

    return { ok: true, id: archived.id };
  });
};
