import type { FastifyInstance } from "fastify";
import type { DataClient, Position } from "@mx2/polymarket-client";
import { deriveDepositWallet } from "@mx2/polymarket-client";
import type { SessionStore } from "@mx2/db";
import { makeRequireAuth } from "../middleware/require-auth.js";
import type {} from "../auth/types.js";

export interface ProfileRoutesDeps {
  dataClient: DataClient;
  sessions: SessionStore;
}

const PNL_METHODOLOGY =
  "Unrealized PnL = sum(currentValue − initialValue) per open position. " +
  "Realized PnL = sum of realizedPnl fields reported by Polymarket Data API. " +
  "Source: Polymarket Data API /positions endpoint.";

const PNL_LIMITATIONS = [
  "Pre-beta trading history may be incomplete if the wallet traded before connecting here",
  "USDC transfers between wallets are not tracked",
  "Split, merge, and redeem events may not be fully reflected in realized PnL",
  "Queries default to your derived Polymarket deposit wallet; pass ?proxyWallet=0x... to inspect a different wallet",
];

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// The Polymarket Data API keys off the proxy/deposit wallet, not the signer EOA.
// Resolution order:
//   1. explicit ?proxyWallet=<address> override (e.g. to inspect another wallet);
//   2. the deposit (Gnosis Safe) wallet deterministically derived from the EOA;
//   3. the raw EOA as a last resort if derivation fails.
const resolveQueryAddress = (
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

const computePnlSummary = (positions: Position[]) => {
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

export const registerProfileRoutes = (app: FastifyInstance, deps: ProfileRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  app.get("/api/profile/positions", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const q = req.query as Record<string, string>;
    const queryAddress = resolveQueryAddress({ user }, q);

    const result = await deps.dataClient.getPositions({ user: queryAddress, sizeThreshold: 0.01 });
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
    const limit = q["limit"] !== undefined ? Math.min(Number(q["limit"]), 200) : 50;
    const queryAddress = resolveQueryAddress({ user }, q);

    const result = await deps.dataClient.getActivity({ user: queryAddress, limit });
    if (!result.ok) {
      reply.code(result.error.statusCode === 429 ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    return {
      signerAddress: user.walletAddress,
      queryAddress,
      activity: result.value,
      count: result.value.length,
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

    const result = await deps.dataClient.getPositions({ user: queryAddress, sizeThreshold: 0.01 });
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
};
