import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { AuditStore, PrivyWalletStore, SessionStore, TradingAccountStore } from "@mx2/db";
import type { BridgeClient, GeoblockClient } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeGeoblockCheck } from "../middleware/geoblock.js";

export interface FundsRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  auditStore: AuditStore;
  tradingAccounts: TradingAccountStore;
  privyWallets: PrivyWalletStore;
  bridgeClient: BridgeClient;
  geoblockClient: GeoblockClient;
}

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

  app.post(
    "/api/funds/deposit-addresses",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureBridgeFundingEnabled(deps.config, reply)) return reply;
      await geoblockCheck(req, reply);
      if (reply.sent) return reply;

      const user = req.user!;
      const wallet = await deps.privyWallets.find(user.walletAddress);
      if (!wallet) {
        reply.code(400);
        return {
          error: "TRADING_WALLET_NOT_PROVISIONED",
          message: "Create an Arima trading wallet before using Bridge funding.",
        };
      }

      const internal = (await deps.tradingAccounts.listByOwner(user.walletAddress)).find(
        (account) =>
          account.kind === "internal_privy" &&
          account.signerAddress.toLowerCase() === wallet.embeddedAddress.toLowerCase() &&
          account.depositWalletAddress,
      );
      if (!internal?.depositWalletAddress) {
        reply.code(409);
        return {
          error: "DEPOSIT_WALLET_REQUIRED",
          message: "Activate the deposit wallet before requesting Bridge deposit addresses.",
        };
      }

      const result = await deps.bridgeClient.createDepositAddresses({
        polymarketWalletAddress: internal.depositWalletAddress,
      });
      if (!result.ok) {
        reply.code(result.error.code === "RATE_LIMIT" ? 429 : 502);
        return { error: result.error.code, message: result.error.message };
      }

      await deps.auditStore.emit({
        actor: user.walletAddress,
        action: "wallet.bridge.deposit_addresses_requested",
        subject: `trading_account:${internal.id}`,
        metadata: { depositWalletAddress: internal.depositWalletAddress },
      });

      return {
        ok: true,
        depositWalletAddress: internal.depositWalletAddress,
        addresses: result.value,
      };
    },
  );
};
