import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import type {
  AuditStore,
  BridgeStore,
  PrivyWalletStore,
  SessionStore,
  TradingAccountStore,
} from "@mx2/db";
import { PUSD_ADDRESS, type BridgeClient, type GeoblockClient } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeGeoblockCheck } from "../middleware/geoblock.js";

export interface FundsRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingAccounts: TradingAccountStore;
  privyWallets: PrivyWalletStore;
  bridgeClient: BridgeClient;
  bridgeStore: BridgeStore;
  geoblockClient: GeoblockClient;
}

/** POST /api/funds/quote body — deposit-direction estimate. */
const QuoteSchema = z
  .object({
    fromChainId: z.string().min(1).max(32),
    fromTokenAddress: z.string().min(1).max(128),
    /** Source-token base units (e.g. 5 USDC = "5000000"). */
    fromAmountBaseUnit: z.string().regex(/^\d{1,30}$/),
  })
  .strict();

/** Addresses refreshed per on-request status pull (bounds Bridge traffic). */
const REFRESH_ADDRESS_LIMIT = 5;
/**
 * Skip addresses checked more recently than this. The UI polls ~4s while a
 * deposit is in flight (and across tabs); this keeps the Bridge seeing at
 * most one status call per address per interval server-wide.
 */
const REFRESH_MIN_INTERVAL_MS = 5_000;

const addressTypeForChain = (chainName: string): "evm" | "svm" | "btc" | "tvm" => {
  const normalized = chainName.toLowerCase();
  if (normalized === "solana") return "svm";
  if (normalized === "bitcoin") return "btc";
  if (normalized === "tron") return "tvm";
  return "evm";
};

const ensureBridgeFundingEnabled = (config: AppConfig, reply: FastifyReply): boolean => {
  if (config.features.bridgeFunding) return true;
  reply.code(503);
  void reply.send({
    error: "BRIDGE_FUNDING_DISABLED",
    message: "Multi-chain Bridge funding is not enabled on this build.",
  });
  return false;
};

export const registerFundsRoutes = (app: FastifyInstance, deps: FundsRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });
  const geoblockCheck = makeGeoblockCheck({
    geoblockClient: deps.geoblockClient,
    auditStore: deps.auditStore,
  });

  app.get("/api/funds/assets", async (_req, reply) => {
    if (!deps.config.features.bridgeFunding) {
      return {
        enabled: false,
        assets: [],
        chains: [],
        note: "Multi-chain Bridge funding is disabled on this build.",
      };
    }

    const result = await deps.bridgeClient.getSupportedAssets();
    if (!result.ok) {
      reply.code(result.error.code === "RATE_LIMIT" ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    const assets = result.value.supportedAssets.map((asset) => ({
      id: `${asset.chainId}:${asset.token.address.toLowerCase()}`,
      chainId: asset.chainId,
      chainName: asset.chainName,
      addressType: addressTypeForChain(asset.chainName),
      minCheckoutUsd: asset.minCheckoutUsd,
      token: asset.token,
    }));

    const chainMap = new Map<
      string,
      {
        chainId: string;
        chainName: string;
        addressType: string;
        assetCount: number;
        minCheckoutUsd: number;
      }
    >();
    for (const asset of assets) {
      const existing = chainMap.get(asset.chainId);
      if (existing) {
        existing.assetCount += 1;
        existing.minCheckoutUsd = Math.min(existing.minCheckoutUsd, asset.minCheckoutUsd);
      } else {
        chainMap.set(asset.chainId, {
          chainId: asset.chainId,
          chainName: asset.chainName,
          addressType: asset.addressType,
          assetCount: 1,
          minCheckoutUsd: asset.minCheckoutUsd,
        });
      }
    }

    return {
      enabled: true,
      assets,
      chains: Array.from(chainMap.values()).sort((a, b) => a.chainName.localeCompare(b.chainName)),
      note: result.value.note ?? null,
    };
  });

  /** Pure lookup of the caller's current internal deposit wallet. */
  const findDepositWallet = async (
    walletAddress: string,
  ): Promise<
    | { state: "no_wallet" }
    | { state: "no_deposit_wallet" }
    | { state: "ok"; depositWalletAddress: string; accountId: string }
  > => {
    const wallet = await deps.privyWallets.find(walletAddress);
    if (!wallet) return { state: "no_wallet" };
    const internal = (await deps.tradingAccounts.listByOwner(walletAddress)).find(
      (account) =>
        account.kind === "internal_privy" &&
        account.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase() &&
        account.depositWalletAddress,
    );
    if (!internal?.depositWalletAddress) return { state: "no_deposit_wallet" };
    return {
      state: "ok",
      depositWalletAddress: internal.depositWalletAddress,
      accountId: internal.id,
    };
  };

  /** Resolve the caller's internal deposit wallet, or send the failure reply. */
  const resolveDepositWallet = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ depositWalletAddress: string; accountId: string } | null> => {
    const found = await findDepositWallet(req.user!.walletAddress);
    if (found.state === "no_wallet") {
      reply.code(400);
      void reply.send({
        error: "TRADING_WALLET_NOT_PROVISIONED",
        message: "Create an Arima trading wallet before using Bridge funding.",
      });
      return null;
    }
    if (found.state === "no_deposit_wallet") {
      reply.code(409);
      void reply.send({
        error: "DEPOSIT_WALLET_REQUIRED",
        message: "Activate the deposit wallet before requesting Bridge deposit addresses.",
      });
      return null;
    }
    return { depositWalletAddress: found.depositWalletAddress, accountId: found.accountId };
  };

  // ── GET /api/funds/deposit-addresses — previously generated addresses ─────
  // Reads our own store only (no Bridge call, no geoblock) so the sheet can
  // render the address instantly on open; POST creates addresses the first
  // time. Rows are scoped to the CURRENT deposit wallet: after a
  // re-provision, stale addresses that would pay an old wallet never surface.
  app.get(
    "/api/funds/deposit-addresses",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;
      const user = req.user!;
      const found = await findDepositWallet(user.walletAddress);
      if (found.state !== "ok") return { ok: true, depositWalletAddress: null, addresses: {} };

      const rows = (await deps.bridgeStore.listAddresses(user.walletAddress, "deposit")).filter(
        (row) =>
          row.depositWalletAddress.toLowerCase() === found.depositWalletAddress.toLowerCase(),
      );
      const addresses: Record<string, string> = {};
      for (const row of rows) {
        if (!(row.addressType in addresses)) addresses[row.addressType] = row.address;
      }
      return { ok: true, depositWalletAddress: found.depositWalletAddress, addresses };
    },
  );

  app.post(
    "/api/funds/deposit-addresses",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;
      await geoblockCheck(req, reply);
      if (reply.sent) return reply;

      const user = req.user!;
      const resolved = await resolveDepositWallet(req, reply);
      if (!resolved) return reply;

      const result = await deps.bridgeClient.createDepositAddresses({
        polymarketWalletAddress: resolved.depositWalletAddress,
      });
      if (!result.ok) {
        reply.code(result.error.code === "RATE_LIMIT" ? 429 : 502);
        return { error: result.error.code, message: result.error.message };
      }

      // Persist each family address: the sheet reuses them across opens and
      // the status poller learns what to watch.
      for (const [addressType, address] of Object.entries(result.value)) {
        if (!address) continue;
        await deps.bridgeStore.saveAddress({
          walletAddress: user.walletAddress,
          depositWalletAddress: resolved.depositWalletAddress,
          kind: "deposit",
          addressType,
          address,
        });
      }

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "wallet.bridge.deposit_addresses_requested",
        subject: `trading_account:${resolved.accountId}`,
        metadata: { depositWalletAddress: resolved.depositWalletAddress },
      });

      return {
        ok: true,
        depositWalletAddress: resolved.depositWalletAddress,
        addresses: result.value,
      };
    },
  );

  // ── POST /api/funds/quote — deposit-direction fee/ETA estimate ────────────
  app.post(
    "/api/funds/quote",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;

      const parsed = QuoteSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "INVALID_REQUEST",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }
      const resolved = await resolveDepositWallet(req, reply);
      if (!resolved) return reply;

      // Server fills the pUSD leg: destination is always the user's own
      // deposit wallet on Polygon — the browser never supplies it.
      const result = await deps.bridgeClient.getQuote({
        fromAmountBaseUnit: parsed.data.fromAmountBaseUnit,
        fromChainId: parsed.data.fromChainId,
        fromTokenAddress: parsed.data.fromTokenAddress,
        recipientAddress: resolved.depositWalletAddress,
        toChainId: "137",
        toTokenAddress: PUSD_ADDRESS,
      });
      if (!result.ok) {
        reply.code(result.error.code === "RATE_LIMIT" ? 429 : 502);
        return { error: result.error.code, message: result.error.message };
      }
      const q = result.value;
      return {
        quoteId: q.quoteId ?? null,
        estCheckoutTimeMs: q.estCheckoutTimeMs ?? null,
        estToTokenBaseUnit: q.estToTokenBaseUnit ?? null,
        estInputUsd: q.estInputUsd ?? null,
        estOutputUsd: q.estOutputUsd ?? null,
        fees: {
          appFeeLabel: q.estFeeBreakdown?.appFeeLabel ?? null,
          appFeeUsd: q.estFeeBreakdown?.appFeeUsd ?? null,
          gasUsd: q.estFeeBreakdown?.gasUsd ?? null,
          totalImpactUsd: q.estFeeBreakdown?.totalImpactUsd ?? null,
          minReceived: q.estFeeBreakdown?.minReceived ?? null,
        },
      };
    },
  );

  // ── GET /api/funds/deposits — tracked bridge deposits (+ live refresh) ────
  app.get(
    "/api/funds/deposits",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;
      const user = req.user!;

      if ((req.query as Record<string, string>)["refresh"] === "1") {
        // Bounded on-request status pull — covers deployments where the
        // worker poller is off, without unbounded Bridge traffic. Stalest
        // first, skipping anything checked within REFRESH_MIN_INTERVAL_MS.
        const staleBefore = Date.now() - REFRESH_MIN_INTERVAL_MS;
        const addresses = (await deps.bridgeStore.listAddresses(user.walletAddress, "deposit"))
          .filter((row) => !row.lastCheckedAt || row.lastCheckedAt.getTime() < staleBefore)
          .sort((a, b) => (a.lastCheckedAt?.getTime() ?? 0) - (b.lastCheckedAt?.getTime() ?? 0))
          .slice(0, REFRESH_ADDRESS_LIMIT);
        for (const address of addresses) {
          const status = await deps.bridgeClient.getStatus(address.address);
          if (!status.ok) continue; // fail-soft: stale rows beat a hard error
          const { changed } = await deps.bridgeStore.upsertDepositsFromStatus(
            address,
            status.value.transactions.map((tx) => ({
              fromChainId: tx.fromChainId,
              fromTokenAddress: tx.fromTokenAddress,
              fromAmountBaseUnit: tx.fromAmountBaseUnit,
              status: tx.status,
              txHash: tx.txHash,
              createdTimeMs: tx.createdTimeMs,
              raw: tx,
            })),
          );
          await deps.bridgeStore.markAddressChecked(address.id);
          for (const change of changed) {
            await deps.auditStore.emit({
              actor: user.walletAddress,
              action: "wallet.bridge.deposit_state_changed",
              subject: `bridge_deposit:${change.row.id}`,
              metadata: { from: change.previousState, to: change.row.state },
            });
          }
        }
      }

      const deposits = await deps.bridgeStore.listDepositsByWallet(user.walletAddress);
      return {
        deposits: deposits.map((d) => ({
          id: d.id,
          fromChainId: d.fromChainId,
          fromTokenAddress: d.fromTokenAddress,
          fromAmountBaseUnit: d.fromAmountBaseUnit,
          state: d.state,
          providerStatus: d.providerStatus,
          txHash: d.txHash,
          dismissedAt: d.dismissedAt,
          completionSource: d.completionSource,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      };
    },
  );

  // ── POST /api/funds/deposits/:id/dismiss — hide a stuck transfer record ───
  // The record stays in history; only active surfaces (pill/tracker) drop it.
  app.post(
    "/api/funds/deposits/:id/dismiss",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;
      const user = req.user!;
      const { id } = req.params as { id: string };
      const dismissed = await deps.bridgeStore.dismissDeposit(user.walletAddress, id);
      if (!dismissed) {
        reply.code(404);
        return { error: "NOT_FOUND", message: "Deposit not found or already dismissed." };
      }
      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "wallet.bridge.deposit_dismissed",
        subject: `bridge_deposit:${id}`,
        metadata: { state: dismissed.state },
      });
      return { ok: true, id: dismissed.id, dismissedAt: dismissed.dismissedAt };
    },
  );
};
