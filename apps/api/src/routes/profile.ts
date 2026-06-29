import { getAddress } from "viem";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { ClobCredentialStore, SessionStore } from "@mx2/db";
import type {
  Activity,
  AuthenticatedClobClient,
  DataClient,
  GammaClient,
  L2Credentials,
  OpenOrder,
  Position,
} from "@mx2/polymarket-client";
import { deriveDepositWallet } from "@mx2/polymarket-client";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { decryptCredentials } from "../auth/crypto.js";
import {
  buildEquityHistory,
  EQUITY_DISCLAIMER,
  EQUITY_METHODOLOGY,
  type EquityWindow,
} from "../profile/equity-history.js";
import type {} from "../auth/types.js";

export interface ProfileRoutesDeps {
  dataClient: DataClient;
  sessions: SessionStore;
  clobCredentials: ClobCredentialStore;
  tradingClobClient: AuthenticatedClobClient;
  config: AppConfig;
  gammaClient: GammaClient;
}

export const PNL_METHODOLOGY =
  "Unrealized PnL = sum(currentValue − initialValue) per open position. " +
  "Realized PnL = sum of realizedPnl fields reported by Polymarket Data API. " +
  "Source: Polymarket Data API /positions endpoint.";

export const PNL_LIMITATIONS = [
  "Pre-beta trading history may be incomplete if the wallet traded before connecting here",
  "USDC transfers between wallets are not tracked",
  "Split, merge, and redeem events may not be fully reflected in realized PnL",
  "Queries default to your derived Polymarket deposit wallet; pass ?proxyWallet=0x... to inspect a different wallet",
];

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const clobSignerAddress = (walletAddress: string): `0x${string}` =>
  getAddress(walletAddress as `0x${string}`);

export const resolveQueryAddress = (
  req: { user: { walletAddress: string } | null },
  q: Record<string, string>,
): string => {
  const proxy = q["proxyWallet"];
  if (proxy && ETH_ADDRESS_RE.test(proxy)) return proxy.toLowerCase();
  const eoa = req.user?.walletAddress;
  if (!eoa) return "";
  try {
    return deriveDepositWallet(eoa).toLowerCase();
  } catch {
    return eoa;
  }
};

export const computePnlSummary = (positions: Position[]) => {
  let unrealized = 0;
  let realized = 0;
  let currentPortfolio = 0;

  for (const pos of positions) {
    const current = pos.currentValue;
    const initial = pos.initialValue;
    unrealized += current - initial;
    realized += pos.realizedPnl;
    currentPortfolio += current;
  }

  return {
    unrealizedPnl: unrealized.toFixed(4),
    realizedPnl: realized.toFixed(4),
    totalPnl: (unrealized + realized).toFixed(4),
    currentPortfolioValue: currentPortfolio.toFixed(4),
    openPositions: positions.length,
  };
};

const parseHistoryType = (raw: string | undefined): "all" | "trade" | "redeem" | "other" => {
  if (raw === "trade" || raw === "redeem" || raw === "other") return raw;
  return "all";
};

const filterActivity = (activity: Activity[], type: "all" | "trade" | "redeem" | "other") => {
  if (type === "all") return activity;
  if (type === "trade") return activity.filter((a) => a.type === "TRADE");
  if (type === "redeem") return activity.filter((a) => a.type === "REDEEM");
  return activity.filter((a) => a.type !== "TRADE" && a.type !== "REDEEM");
};

const parseEquityWindow = (raw: string | undefined): EquityWindow => {
  if (raw === "7d" || raw === "30d" || raw === "all") return raw;
  return "30d";
};

const tryDecryptCreds = async (
  deps: ProfileRoutesDeps,
  walletAddress: string,
): Promise<L2Credentials | null> => {
  if (!deps.config.encryptionMasterKey) return null;
  const row = await deps.clobCredentials.find(walletAddress);
  if (!row) return null;
  return decryptCredentials<L2Credentials>(
    row.encryptedCreds as Parameters<typeof decryptCredentials>[0],
    deps.config.encryptionMasterKey,
  );
};

const fetchTradingSnapshot = async (deps: ProfileRoutesDeps, walletAddress: string) => {
  const creds = await tryDecryptCreds(deps, walletAddress);
  if (!creds) {
    return { setupRequired: true as const, balance: null, openOrders: [] as OpenOrder[] };
  }
  const signer = clobSignerAddress(walletAddress);
  const [balResult, ordersResult] = await Promise.all([
    deps.tradingClobClient.getBalanceAllowance(signer, creds),
    deps.tradingClobClient.getOpenOrders(signer, creds),
  ]);
  return {
    setupRequired: false as const,
    balance: balResult.ok ? balResult.value.balance : null,
    openOrders: ordersResult.ok ? ordersResult.value : [],
  };
};

export type EnrichedOpenOrder = OpenOrder & {
  title?: string;
  marketId?: string;
  slug?: string;
};

const enrichOpenOrder = async (
  deps: ProfileRoutesDeps,
  order: OpenOrder,
): Promise<EnrichedOpenOrder> => {
  const tokenId = order.asset_id;
  const marketResult = await deps.gammaClient.findMarket({ tokenId });
  if (!marketResult.ok || !marketResult.value) return order;
  const m = marketResult.value;
  return {
    ...order,
    title: m.question,
    marketId: m.id,
    slug: m.slug,
  };
};

export const registerProfileRoutes = (app: FastifyInstance, deps: ProfileRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const fetchPositions = async (queryAddress: string) =>
    deps.dataClient.getPositions({ user: queryAddress, sizeThreshold: 0.01 });

  app.get("/api/profile/positions", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const queryAddress = resolveQueryAddress({ user }, q);

    const result = await fetchPositions(queryAddress);
    if (!result.ok) {
      reply.code(result.error.statusCode === 429 ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      positions: result.value,
      count: result.value.length,
      dataSource: "Polymarket Data API",
      fetchedAt: new Date().toISOString(),
    };
  });

  app.get("/api/profile/history", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const limit = q["limit"] !== undefined ? Math.min(Math.max(Number(q["limit"]), 1), 200) : 50;
    const offset = q["offset"] !== undefined ? Math.max(Number(q["offset"]), 0) : 0;
    const typeFilter = parseHistoryType(q["type"]);
    const queryAddress = resolveQueryAddress({ user }, q);

    const fetchLimit = Math.min(offset + limit, 200);
    const result = await deps.dataClient.getActivity({ user: queryAddress, limit: fetchLimit });
    if (!result.ok) {
      reply.code(result.error.statusCode === 429 ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    const filtered = filterActivity(result.value, typeFilter);
    const page = filtered.slice(offset, offset + limit);

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      activity: page,
      count: page.length,
      totalFetched: filtered.length,
      hasMore: filtered.length > offset + limit,
      dataSource: "Polymarket Data API",
      fetchedAt: new Date().toISOString(),
    };
  });

  app.get("/api/profile/pnl", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const queryAddress = resolveQueryAddress({ user }, q);

    const result = await fetchPositions(queryAddress);
    if (!result.ok) {
      reply.code(result.error.statusCode === 429 ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      computedAt: new Date().toISOString(),
      dataSource: "Polymarket Data API",
      summary: computePnlSummary(result.value),
      methodology: PNL_METHODOLOGY,
      limitations: PNL_LIMITATIONS,
    };
  });

  app.get("/api/profile/overview", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const queryAddress = resolveQueryAddress({ user }, q);

    const [posResult, activityResult, trading] = await Promise.all([
      fetchPositions(queryAddress),
      deps.dataClient.getActivity({ user: queryAddress, limit: 5 }),
      fetchTradingSnapshot(deps, user.walletAddress),
    ]);

    if (!posResult.ok) {
      reply.code(posResult.error.statusCode === 429 ? 429 : 502);
      return { error: posResult.error.code, message: posResult.error.message };
    }

    const activityPreview = activityResult.ok ? activityResult.value : [];

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      fetchedAt: new Date().toISOString(),
      dataSource: "Polymarket Data API",
      summary: computePnlSummary(posResult.value),
      positions: posResult.value,
      activityPreview,
      counts: {
        openOrders: trading.openOrders.length,
        usdcBalance: trading.balance,
        setupRequired: trading.setupRequired,
      },
      methodology: PNL_METHODOLOGY,
      limitations: PNL_LIMITATIONS,
    };
  });

  app.get("/api/profile/equity-history", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const queryAddress = resolveQueryAddress({ user }, q);
    const window = parseEquityWindow(q["window"]);

    const [posResult, activityResult] = await Promise.all([
      fetchPositions(queryAddress),
      deps.dataClient.getActivity({ user: queryAddress, limit: 200 }),
    ]);

    if (!posResult.ok) {
      reply.code(posResult.error.statusCode === 429 ? 429 : 502);
      return { error: posResult.error.code, message: posResult.error.message };
    }
    if (!activityResult.ok) {
      reply.code(activityResult.error.statusCode === 429 ? 429 : 502);
      return { error: activityResult.error.code, message: activityResult.error.message };
    }

    const points = buildEquityHistory(activityResult.value, posResult.value, window);

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      window,
      points,
      disclaimer: EQUITY_DISCLAIMER,
      methodology: EQUITY_METHODOLOGY,
      computedAt: new Date().toISOString(),
    };
  });

  app.get("/api/profile/open-orders", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    const trading = await fetchTradingSnapshot(deps, user.walletAddress);
    const enriched = await Promise.all(trading.openOrders.map((o) => enrichOpenOrder(deps, o)));

    return {
      signerAddress: user.walletAddress,
      setupRequired: trading.setupRequired,
      balance: trading.balance,
      openOrders: enriched,
      count: enriched.length,
      fetchedAt: new Date().toISOString(),
    };
  });
};
