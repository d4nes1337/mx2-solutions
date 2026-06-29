import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { AuditStore, SessionStore, PrivyWalletStore, DelegationStore } from "@mx2/db";
import type { TradingSigner } from "@mx2/trading-signer";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { ensureAllowances, type AllowanceReader } from "../trade/allowance-bootstrap.js";

export interface TradingWalletRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingSigner: TradingSigner;
  privyWallets: PrivyWalletStore;
  delegations: DelegationStore;
  /** null when POLYGON_RPC_URL is not configured (allowance bootstrap unavailable). */
  allowanceReader: AllowanceReader | null;
}

/**
 * Onboarding for server-side ("sign once") trading. The user:
 *  1. POST /provision  → we create a Privy-managed embedded wallet (key in Privy's
 *     enclave; we store only references). They fund it with a bounded amount.
 *  2. POST /delegate   → records their one-time consent granting the server signing
 *     authority for a bounded time (the single wallet popup happens client-side via
 *     the Privy React SDK; here we persist the delegation + expiry).
 * After that, manual orders and conditional auto-execution sign with no further popup.
 */
export const registerTradingWalletRoutes = (
  app: FastifyInstance,
  deps: TradingWalletRoutesDeps,
): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const ensureEnabled = (reply: FastifyReply): boolean => {
    if (!deps.config.features.privySigning) {
      reply.code(503);
      void reply.send({
        error: "PRIVY_SIGNING_DISABLED",
        message: "Server-side signing is not enabled.",
      });
      return false;
    }
    return true;
  };

  // ── POST /api/trading-wallet/provision ────────────────────────────────────
  app.post("/api/trading-wallet/provision", { preHandler: requireAuth }, async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const user = req.user!;

    const existing = await deps.privyWallets.find(user.walletAddress);
    if (existing) {
      return {
        ok: true,
        embeddedAddress: existing.embeddedAddress,
        allowancesBootstrapped: existing.allowancesBootstrappedAt !== null,
        alreadyProvisioned: true,
      };
    }

    const provisioned = await deps.tradingSigner.provisionWallet(user.walletAddress);
    if (!provisioned.ok) {
      reply.code(502);
      return { error: "PROVISION_FAILED", message: provisioned.error.message };
    }

    const row = await deps.privyWallets.upsert({
      walletAddress: user.walletAddress,
      privyUserId: user.walletAddress,
      privyWalletId: provisioned.value.walletId,
      embeddedAddress: provisioned.value.address,
      policyId: deps.config.privy.tradingPolicyId ?? null,
    });

    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_wallet.provisioned",
      subject: `wallet:${user.walletAddress}`,
      metadata: { embeddedAddress: row.embeddedAddress, policyId: row.policyId },
    });

    return {
      ok: true,
      embeddedAddress: row.embeddedAddress,
      alreadyProvisioned: false,
      fundingInstructions: `Send USDC on Polygon to ${row.embeddedAddress}. Your maximum possible loss is bounded by the amount you load; your primary wallet is never touched.`,
    };
  });

  // ── POST /api/trading-wallet/delegate ─────────────────────────────────────
  app.post("/api/trading-wallet/delegate", { preHandler: requireAuth }, async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const user = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const wallet = await deps.privyWallets.find(user.walletAddress);
    if (!wallet) {
      reply.code(400);
      return {
        error: "TRADING_WALLET_NOT_PROVISIONED",
        message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
      };
    }

    const ttlMs = deps.config.limits.sessionSignerTtlSeconds * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const sessionSignerId =
      typeof body["sessionSignerId"] === "string" ? body["sessionSignerId"] : null;

    await deps.delegations.create({
      walletAddress: user.walletAddress,
      sessionSignerId,
      expiresAt,
    });

    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_wallet.delegated",
      subject: `wallet:${user.walletAddress}`,
      metadata: { expiresAt: expiresAt.toISOString(), hasSessionSigner: sessionSignerId !== null },
    });

    return { ok: true, expiresAt: expiresAt.toISOString() };
  });

  // ── GET /api/trading-wallet ───────────────────────────────────────────────
  app.get("/api/trading-wallet", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const wallet = await deps.privyWallets.find(user.walletAddress);
    const delegation = wallet ? await deps.delegations.findActive(user.walletAddress) : null;
    return {
      privySigningEnabled: deps.config.features.privySigning,
      provisioned: wallet !== null,
      embeddedAddress: wallet?.embeddedAddress ?? null,
      allowancesBootstrapped: wallet?.allowancesBootstrappedAt != null,
      delegationActive: delegation !== null,
      delegationExpiresAt: delegation?.expiresAt.toISOString() ?? null,
    };
  });

  // ── POST /api/trading-wallet/bootstrap-allowances ─────────────────────────
  // One-time USDC + CTF approvals to the Polymarket exchanges (server-signed,
  // idempotent). Fail-closed: orders are refused until this succeeds.
  app.post(
    "/api/trading-wallet/bootstrap-allowances",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ensureEnabled(reply)) return;
      const user = req.user!;
      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        reply.code(400);
        return {
          error: "TRADING_WALLET_NOT_PROVISIONED",
          message: "Provision a trading wallet first (POST /api/trading-wallet/provision).",
        };
      }
      if (!deps.allowanceReader) {
        reply.code(503);
        return {
          error: "RPC_NOT_CONFIGURED",
          message: "POLYGON_RPC_URL is required to read + bootstrap on-chain allowances.",
        };
      }
      const result = await ensureAllowances(
        {
          signer: deps.tradingSigner,
          reader: deps.allowanceReader,
          privyWallets: deps.privyWallets,
          auditStore: deps.auditStore,
        },
        wallet,
      );
      if (!result.ok) {
        reply.code(502);
        return { error: "ALLOWANCE_BOOTSTRAP_FAILED", message: result.error.message };
      }
      return { ok: true, txHashes: result.value.txHashes };
    },
  );

  // ── POST /api/trading-wallet/revoke ───────────────────────────────────────
  app.post("/api/trading-wallet/revoke", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    await deps.delegations.revoke(user.walletAddress);
    await deps.auditStore.emit({
      actor: user.walletAddress,
      action: "trading_wallet.revoked",
      subject: `wallet:${user.walletAddress}`,
      metadata: {},
    });
    return { ok: true };
  });
};
