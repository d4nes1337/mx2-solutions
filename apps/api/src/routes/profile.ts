import { getAddress } from "viem";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { ClobCredentialStore, SessionStore } from "@mx2/db";
import type {
  Activity,
  AuthenticatedClobClient,
  ClosedPosition,
  DataClient,
  GammaClient,
  L2Credentials,
  OpenOrder,
  Position,
  PublicProfile,
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
  "Total PnL uses Polymarket Data API /v1/leaderboard timePeriod=ALL pnl when available. " +
  "Unrealized PnL is the sum of open-position cashPnl. Realized PnL is account total minus " +
  "open unrealized PnL. Exposure is the current open-position value from /positions.";

export const PNL_LIMITATIONS = [
  "Pre-beta trading history may be incomplete if the wallet traded before connecting here",
  "USDC transfers between wallets are not tracked",
  "Split, merge, and redeem events are shown in activity, but top-line PnL is anchored to Polymarket account-level PnL",
  "Queries default to your Polymarket proxy/deposit wallet; pass ?proxyWallet=0x... to inspect a different wallet",
];

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const clobSignerAddress = (walletAddress: string): `0x${string}` =>
  getAddress(walletAddress as `0x${string}`);

const profileDisplayName = (profile: PublicProfile | null): string | undefined =>
  profile?.name ?? profile?.xUsername ?? profile?.pseudonym ?? undefined;

const fetchPublicProfile = async (
  deps: ProfileRoutesDeps,
  address: string,
): Promise<PublicProfile | null> => {
  const result = await deps.gammaClient.getPublicProfile(address);
  return result.ok ? result.value : null;
};

export const resolveQueryAddress = async (
  deps: ProfileRoutesDeps,
  req: { user: { walletAddress: string } | null },
  q: Record<string, string>,
): Promise<{ queryAddress: string; profile: PublicProfile | null }> => {
  const proxy = q["proxyWallet"];
  if (proxy && ETH_ADDRESS_RE.test(proxy)) {
    const queryAddress = proxy.toLowerCase();
    return { queryAddress, profile: await fetchPublicProfile(deps, queryAddress) };
  }
  const eoa = req.user?.walletAddress;
  if (!eoa) return { queryAddress: "", profile: null };

  const profile = await fetchPublicProfile(deps, eoa);
  if (profile?.proxyWallet && ETH_ADDRESS_RE.test(profile.proxyWallet)) {
    return { queryAddress: profile.proxyWallet.toLowerCase(), profile };
  }

  try {
    const queryAddress = deriveDepositWallet(eoa).toLowerCase();
    return { queryAddress, profile: await fetchPublicProfile(deps, queryAddress) };
  } catch {
    return { queryAddress: eoa, profile };
  }
};

const toFixed4 = (n: number) => n.toFixed(4);
const parseBalance = (balance: string | null): number | null => {
  if (balance == null) return null;
  const n = Number(balance);
  return Number.isFinite(n) ? n : null;
};

export const computePnlSummary = (
  positions: Position[],
  opts?: {
    accountPnl?: number | null;
    cashBalance?: string | null;
    closedPositions?: ClosedPosition[];
    positionValue?: number | null;
  },
) => {
  const unrealized = positions.reduce((sum, pos) => sum + pos.cashPnl, 0);
  const currentPortfolio = positions.reduce((sum, pos) => sum + pos.currentValue, 0);
  const closedRealized = (opts?.closedPositions ?? []).reduce(
    (sum, pos) => sum + pos.realizedPnl,
    0,
  );
  const totalPnl = opts?.accountPnl ?? unrealized + closedRealized;
  const realized = totalPnl - unrealized;
  const cash = parseBalance(opts?.cashBalance ?? null);
  const exposure = currentPortfolio;
  const equity = exposure + (cash ?? 0);

  return {
    unrealizedPnl: toFixed4(unrealized),
    realizedPnl: toFixed4(realized),
    totalPnl: toFixed4(totalPnl),
    currentPortfolioValue: toFixed4(equity),
    positionValue: toFixed4(currentPortfolio),
    dataApiPositionValue: opts?.positionValue != null ? toFixed4(opts.positionValue) : null,
    exposure: toFixed4(exposure),
    cashBalance: cash != null ? toFixed4(cash) : null,
    cashBalanceKnown: cash != null,
    openPositions: positions.length,
    sources: {
      totalPnl:
        opts?.accountPnl != null
          ? "Polymarket Data API /v1/leaderboard"
          : "Derived from positions and closed-positions",
      unrealizedPnl: "Polymarket Data API /positions cashPnl",
      realizedPnl:
        opts?.accountPnl != null
          ? "Implied as account total PnL minus open-position cashPnl"
          : "Polymarket Data API /closed-positions realizedPnl",
      exposure: "Polymarket Data API /positions currentValue",
      cashBalance:
        cash != null
          ? "Polymarket CLOB /balance-allowance"
          : "Unavailable until CLOB credentials are configured",
    },
  };
};

export type MarketPnlStatus =
  | "OPEN_PROFIT"
  | "OPEN_LOSS"
  | "WON"
  | "LOST"
  | "SOLD_PROFIT"
  | "SOLD_LOSS"
  | "FLAT";

const statusLabel = (status: MarketPnlStatus): string => {
  const labels: Record<MarketPnlStatus, string> = {
    OPEN_PROFIT: "Open in profit",
    OPEN_LOSS: "Open in loss",
    WON: "Won",
    LOST: "Lost",
    SOLD_PROFIT: "Sold in profit",
    SOLD_LOSS: "Sold in loss",
    FLAT: "Flat",
  };
  return labels[status];
};

const closedStatus = (p: ClosedPosition): MarketPnlStatus => {
  if (Math.abs(p.realizedPnl) < 0.0001) return "FLAT";
  if (p.curPrice >= 0.995) return p.realizedPnl >= 0 ? "WON" : "SOLD_LOSS";
  if (p.curPrice <= 0.005) return p.realizedPnl <= 0 ? "LOST" : "SOLD_PROFIT";
  return p.realizedPnl >= 0 ? "SOLD_PROFIT" : "SOLD_LOSS";
};

const latestActivityByCondition = (activity: Activity[]): Map<string, number> => {
  const latest = new Map<string, number>();
  for (const a of activity) {
    if (!a.conditionId) continue;
    latest.set(a.conditionId, Math.max(latest.get(a.conditionId) ?? 0, a.timestamp));
  }
  return latest;
};

export const buildMarketPnlFeed = (
  positions: Position[],
  closedPositions: ClosedPosition[],
  activity: Activity[],
) => {
  const latest = latestActivityByCondition(activity);
  const openItems = positions.map((p) => {
    const pnl = p.cashPnl + p.realizedPnl;
    const status: MarketPnlStatus = pnl >= 0 ? "OPEN_PROFIT" : "OPEN_LOSS";
    return {
      id: `open:${p.asset}`,
      source: "positions" as const,
      conditionId: p.conditionId,
      asset: p.asset,
      title: p.title,
      slug: p.slug,
      icon: p.icon,
      outcome: p.outcome,
      status,
      statusLabel: statusLabel(status),
      pnl,
      pnlPct: p.percentPnl,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: p.cashPnl,
      currentValue: p.currentValue,
      exposure: p.currentValue,
      totalBought: p.totalBought,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      size: p.size,
      closed: false,
      lastActivityAt: latest.get(p.conditionId) ?? null,
    };
  });

  const closedItems = closedPositions.map((p) => {
    const status = closedStatus(p);
    const pnlPct = p.totalBought > 0 ? (p.realizedPnl / p.totalBought) * 100 : null;
    return {
      id: `closed:${p.asset}:${p.timestamp}`,
      source: "closed-positions" as const,
      conditionId: p.conditionId,
      asset: p.asset,
      title: p.title,
      slug: p.slug,
      icon: p.icon,
      outcome: p.outcome,
      status,
      statusLabel: statusLabel(status),
      pnl: p.realizedPnl,
      pnlPct,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: 0,
      currentValue: 0,
      exposure: 0,
      totalBought: p.totalBought,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      size: null,
      closed: true,
      lastActivityAt: p.timestamp,
    };
  });

  return [...openItems, ...closedItems]
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, 75);
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
    deps.dataClient.getPositions({ user: queryAddress, sizeThreshold: 0.01, limit: 500 });

  const fetchRecentClosedPositions = async (queryAddress: string, limit = 50) =>
    deps.dataClient.getClosedPositions({
      user: queryAddress,
      limit,
      offset: 0,
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    });

  const fetchClosedHistory = async (queryAddress: string, window: EquityWindow) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = window === "all" ? null : nowSec - (window === "7d" ? 7 : 30) * 24 * 60 * 60;
    const pageSize = 50;
    const maxRows = 500;
    const rows: ClosedPosition[] = [];

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const page = await deps.dataClient.getClosedPositions({
        user: queryAddress,
        limit: pageSize,
        offset,
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      });
      if (!page.ok) return page;
      rows.push(...page.value);
      if (page.value.length < pageSize) break;
      if (startSec !== null && page.value.every((p) => p.timestamp < startSec)) break;
    }

    return {
      ok: true as const,
      value: startSec === null ? rows : rows.filter((p) => p.timestamp >= startSec),
    };
  };

  app.get("/api/profile/positions", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const { queryAddress } = await resolveQueryAddress(deps, { user }, q);

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
    const { queryAddress } = await resolveQueryAddress(deps, { user }, q);

    const fetchLimit = Math.min(offset + limit, 500);
    const result = await deps.dataClient.getActivity({
      user: queryAddress,
      limit: fetchLimit,
      start: 1,
    });
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
    const { queryAddress } = await resolveQueryAddress(deps, { user }, q);

    const [posResult, closedResult, leaderboardResult, valueResult, trading] = await Promise.all([
      fetchPositions(queryAddress),
      fetchRecentClosedPositions(queryAddress),
      deps.dataClient.getLeaderboardEntry({ user: queryAddress, timePeriod: "ALL" }),
      deps.dataClient.getPositionValue({ user: queryAddress }),
      fetchTradingSnapshot(deps, user.walletAddress),
    ]);
    if (!posResult.ok) {
      reply.code(posResult.error.statusCode === 429 ? 429 : 502);
      return { error: posResult.error.code, message: posResult.error.message };
    }

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      computedAt: new Date().toISOString(),
      dataSource: "Polymarket Data API",
      summary: computePnlSummary(posResult.value, {
        accountPnl: leaderboardResult.ok ? (leaderboardResult.value?.pnl ?? null) : null,
        cashBalance: trading.balance,
        closedPositions: closedResult.ok ? closedResult.value : [],
        positionValue: valueResult.ok ? (valueResult.value?.value ?? null) : null,
      }),
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
    const { queryAddress, profile } = await resolveQueryAddress(deps, { user }, q);

    const [posResult, closedResult, activityResult, leaderboardResult, valueResult, trading] =
      await Promise.all([
        fetchPositions(queryAddress),
        fetchRecentClosedPositions(queryAddress),
        deps.dataClient.getActivity({ user: queryAddress, limit: 100, start: 1 }),
        deps.dataClient.getLeaderboardEntry({ user: queryAddress, timePeriod: "ALL" }),
        deps.dataClient.getPositionValue({ user: queryAddress }),
        fetchTradingSnapshot(deps, user.walletAddress),
      ]);

    if (!posResult.ok) {
      reply.code(posResult.error.statusCode === 429 ? 429 : 502);
      return { error: posResult.error.code, message: posResult.error.message };
    }

    const activityPreview = activityResult.ok ? activityResult.value : [];
    const closedPositions = closedResult.ok ? closedResult.value : [];
    const marketPnl = buildMarketPnlFeed(posResult.value, closedPositions, activityPreview);

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      profile: profile
        ? {
            name: profileDisplayName(profile),
            profileImage: profile.profileImage ?? null,
            proxyWallet: profile.proxyWallet ?? queryAddress,
            xUsername: profile.xUsername ?? null,
            verifiedBadge: profile.verifiedBadge ?? false,
          }
        : null,
      fetchedAt: new Date().toISOString(),
      dataSource: "Polymarket Data API",
      summary: computePnlSummary(posResult.value, {
        accountPnl: leaderboardResult.ok ? (leaderboardResult.value?.pnl ?? null) : null,
        cashBalance: trading.balance,
        closedPositions,
        positionValue: valueResult.ok ? (valueResult.value?.value ?? null) : null,
      }),
      positions: posResult.value,
      activityPreview,
      closedPositions,
      marketPnl,
      counts: {
        openOrders: trading.openOrders.length,
        usdcBalance: trading.balance,
        setupRequired: trading.setupRequired,
        marketPnl: marketPnl.length,
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
    const { queryAddress } = await resolveQueryAddress(deps, { user }, q);
    const window = parseEquityWindow(q["window"]);

    const [closedResult, leaderboardResult, posResult] = await Promise.all([
      fetchClosedHistory(queryAddress, window),
      deps.dataClient.getLeaderboardEntry({ user: queryAddress, timePeriod: "ALL" }),
      fetchPositions(queryAddress),
    ]);

    if (!closedResult.ok) {
      reply.code(closedResult.error.statusCode === 429 ? 429 : 502);
      return { error: closedResult.error.code, message: closedResult.error.message };
    }
    const fallbackPnl = posResult.ok ? Number(computePnlSummary(posResult.value).totalPnl) : 0;
    const accountPnl = leaderboardResult.ok
      ? (leaderboardResult.value?.pnl ?? fallbackPnl)
      : fallbackPnl;

    const points = buildEquityHistory(closedResult.value, accountPnl, window);

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
