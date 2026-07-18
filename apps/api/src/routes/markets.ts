import type { FastifyInstance } from "fastify";
import type {
  GammaClient,
  ClobClient,
  DataClient,
  GetPricesHistoryParams,
} from "@mx2/polymarket-client";
import type { MarketSnapshotStore } from "@mx2/db";
import { makeRateLimit } from "../middleware/rate-limit.js";
import { getMarketScenarios } from "../lib/scenarios.js";
import { groupedEventByToken } from "../lib/event-siblings.js";

export interface MarketsRoutesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
  dataClient: DataClient;
  marketSnapshots: MarketSnapshotStore;
  /** Routes the scenarios' farm_rewards card to the cockpit when on. */
  makerLoopEnabled?: boolean;
}

// CLOB token ids are uint256 rendered as decimal strings.
const TOKEN_ID_RE = /^\d{1,100}$/;

// ── Per-market economics (fees + rewards), 5-min in-memory cache ────────────

export interface MarketEconomics {
  feeSchedule: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number | null;
  } | null;
  rewards: {
    minSize: number | null;
    maxSpread: number | null;
    ratePerDayUsd: number | null;
    totalRewards: number | null;
    startDate: string | null;
    endDate: string | null;
  } | null;
  fetchedAt: string;
}

const ECONOMICS_TTL_MS = 5 * 60_000;
const economicsCache = new Map<string, { at: number; value: MarketEconomics }>();

/**
 * Fee source of truth: CLOB `fd`; Gamma `feeSchedule` is the fallback. A null
 * section means UNKNOWN — the UI must say "fee unknown", never assume zero
 * (fail-open display posture, R-029).
 */
const getMarketEconomics = async (
  deps: MarketsRoutesDeps,
  conditionId: string,
): Promise<MarketEconomics> => {
  const hit = economicsCache.get(conditionId);
  if (hit && Date.now() - hit.at < ECONOMICS_TTL_MS) return hit.value;

  const [clobInfo, rewardsRes, gammaRes] = await Promise.all([
    deps.clobClient.getClobMarket(conditionId),
    deps.clobClient.getRewardsMarket(conditionId),
    // Gamma /markets/{id} only accepts numeric ids — a conditionId 422s there.
    deps.gammaClient.findMarket({ conditionId }),
  ]);

  const gamma = gammaRes.ok ? gammaRes.value : null; // null also when not found
  const fd = clobInfo.ok ? clobInfo.value.fd : null;
  const gammaFee = gamma?.feeSchedule ?? null;
  const feeSchedule =
    fd != null
      ? {
          rate: fd.r,
          exponent: fd.e,
          takerOnly: fd.to,
          rebateRate: gammaFee?.rebateRate ?? null,
        }
      : gammaFee != null
        ? {
            rate: gammaFee.rate,
            exponent: gammaFee.exponent,
            takerOnly: gammaFee.takerOnly,
            rebateRate: gammaFee.rebateRate ?? null,
          }
        : gamma?.feesEnabled === false
          ? { rate: 0, exponent: 1, takerOnly: true, rebateRate: null }
          : null;

  const rewardsRow = rewardsRes.ok ? rewardsRes.value[0] : undefined;
  const activeConfig = rewardsRow?.rewards_config?.find((c) => (c.rate_per_day ?? 0) > 0);
  const anyRewards =
    rewardsRow != null || gamma?.rewardsMinSize != null || gamma?.rewardsMaxSpread != null;
  const rewards = anyRewards
    ? {
        minSize: rewardsRow?.rewards_min_size ?? gamma?.rewardsMinSize ?? null,
        maxSpread: rewardsRow?.rewards_max_spread ?? gamma?.rewardsMaxSpread ?? null,
        ratePerDayUsd: activeConfig?.rate_per_day ?? null,
        totalRewards: activeConfig?.total_rewards ?? null,
        startDate: activeConfig?.start_date ?? null,
        endDate: activeConfig?.end_date ?? null,
      }
    : null;

  const value: MarketEconomics = { feeSchedule, rewards, fetchedAt: new Date().toISOString() };
  economicsCache.set(conditionId, { at: Date.now(), value });
  return value;
};

const parseTokenIds = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore malformed clobTokenIds */
  }
  return [];
};

export const registerMarketsRoutes = (app: FastifyInstance, deps: MarketsRoutesDeps): void => {
  // PUBLIC, rate-limited: price history keyed DIRECTLY by CLOB token id. The
  // builder's projection panel only knows tokenIds (no Gamma market id), so the
  // /:id variant below can't serve it. Registered before /:id (static wins).
  app.get(
    "/api/markets/prices-history",
    { preHandler: [makeRateLimit({ scope: "prices-history-token", limit: 60, windowMs: 60_000 })] },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const tokenId = q["tokenId"];
      if (!tokenId || !TOKEN_ID_RE.test(tokenId)) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "valid tokenId required (?tokenId=...)" };
      }

      const histParams: GetPricesHistoryParams = { tokenId, interval: q["interval"] ?? "1m" };
      if (q["fidelity"] !== undefined) histParams.fidelity = Number(q["fidelity"]);
      const histResult = await deps.clobClient.getPricesHistory(histParams);
      if (!histResult.ok) {
        reply.code(502);
        return { error: histResult.error.code, message: histResult.error.message };
      }
      return { tokenId, history: histResult.value };
    },
  );

  // PUBLIC, rate-limited: orderbook keyed DIRECTLY by CLOB token id. The
  // builder's Market tab and cost preview only know tokenIds — the /:id variant
  // below needs a numeric Gamma id (a conditionId 422s at Gamma), which the
  // builder never has. Registered before /:id (static wins). Snapshot-first,
  // CLOB REST fallback, stale snapshot surfaced with the flag set.
  app.get(
    "/api/markets/orderbook",
    { preHandler: [makeRateLimit({ scope: "orderbook-token", limit: 120, windowMs: 60_000 })] },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const tokenId = q["tokenId"];
      if (!tokenId || !TOKEN_ID_RE.test(tokenId)) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "valid tokenId required (?tokenId=...)" };
      }

      const snapshot = await deps.marketSnapshots.findByTokenId(tokenId);
      if (snapshot !== null && !snapshot.isStale) {
        return {
          tokenId,
          bids: snapshot.bids,
          asks: snapshot.asks,
          isStale: false,
          source: snapshot.source,
          receivedAt: snapshot.receivedAt,
        };
      }

      const obResult = await deps.clobClient.getOrderbook(tokenId);
      if (obResult.ok) {
        return {
          tokenId,
          bids: obResult.value.bids,
          asks: obResult.value.asks,
          isStale: false,
          source: "rest",
          receivedAt: new Date().toISOString(),
        };
      }

      if (snapshot !== null) {
        // Stale WS snapshot is better than nothing — surface it with the flag.
        return {
          tokenId,
          bids: snapshot.bids,
          asks: snapshot.asks,
          isStale: true,
          source: snapshot.source,
          receivedAt: snapshot.receivedAt,
        };
      }

      reply.code(502);
      return { error: obResult.error.code, message: obResult.error.message };
    },
  );

  // PUBLIC, rate-limited: per-market fee schedule + liquidity-rewards config
  // (5-min cache above). Null sections mean "unknown", never "zero".
  app.get(
    "/api/markets/:conditionId/economics",
    { preHandler: [makeRateLimit({ scope: "market-economics", limit: 60, windowMs: 60_000 })] },
    async (req) => {
      const { conditionId } = req.params as { conditionId: string };
      return getMarketEconomics(deps, conditionId);
    },
  );

  // Resolve Gamma market metadata by conditionId or CLOB token id (must register before /:id).
  app.get("/api/markets/resolve", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const conditionId = q["conditionId"];
    const tokenId = q["tokenId"];

    if (!conditionId && !tokenId) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "conditionId or tokenId required" };
    }

    const result = await deps.gammaClient.findMarket({
      ...(conditionId ? { conditionId } : {}),
      ...(tokenId ? { tokenId } : {}),
    });

    if (!result.ok) {
      reply.code(result.error.statusCode === 404 ? 404 : 502);
      return { error: result.error.code, message: result.error.message };
    }

    if (!result.value) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Market not found" };
    }

    const m = result.value;
    return {
      marketId: m.id,
      question: m.question,
      slug: m.slug,
      conditionId: m.conditionId,
    };
  });

  // Market detail: Gamma metadata + live orderbook (DB WS snapshot or REST fallback).
  // ── GET /api/markets/siblings?tokenId= — event siblings for a token ───────
  // The builder's "Also in this event" section: token → parent event → the
  // grouped DTO (ordered sub-markets). 30s cached per token/event.
  app.get(
    "/api/markets/siblings",
    { preHandler: [makeRateLimit({ scope: "market-siblings", limit: 60, windowMs: 60_000 })] },
    async (req, reply) => {
      const tokenId = ((req.query as Record<string, string>)["tokenId"] ?? "").trim();
      if (tokenId.length < 4 || tokenId.length > 128) {
        reply.code(400);
        return { error: "INVALID_REQUEST", message: "tokenId is required." };
      }
      const result = await groupedEventByToken(deps.gammaClient, tokenId);
      if (!result.ok) {
        reply.code(502);
        return { error: result.error.code, message: result.error.message };
      }
      return { event: result.value };
    },
  );

  app.get("/api/markets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const marketResult = await deps.gammaClient.getMarket(id);
    if (!marketResult.ok) {
      reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
      return { error: marketResult.error.code, message: marketResult.error.message };
    }
    const market = marketResult.value;
    const tokenIds = parseTokenIds(market.clobTokenIds);
    const firstTokenId = tokenIds[0];

    let orderbookData: unknown = null;
    let orderbookSource: string = "unavailable";
    let isStale = false;

    if (firstTokenId !== undefined) {
      const snapshot = await deps.marketSnapshots.findByTokenId(firstTokenId);
      if (snapshot !== null && !snapshot.isStale) {
        orderbookData = { bids: snapshot.bids, asks: snapshot.asks };
        orderbookSource = snapshot.source;
      } else {
        const obResult = await deps.clobClient.getOrderbook(firstTokenId);
        if (obResult.ok) {
          orderbookData = { bids: obResult.value.bids, asks: obResult.value.asks };
          orderbookSource = "rest";
        } else if (snapshot !== null) {
          // Stale WS snapshot is better than nothing — surface it with the flag set.
          orderbookData = { bids: snapshot.bids, asks: snapshot.asks };
          orderbookSource = snapshot.source;
          isStale = true;
        }
      }
    }

    return {
      ...market,
      _live: { orderbook: orderbookData, orderbookSource, isStale },
    };
  });

  // Dedicated orderbook endpoint; ?outcome=0 (default YES) or ?outcome=1 (NO).
  app.get("/api/markets/:id/orderbook", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;

    const marketResult = await deps.gammaClient.getMarket(id);
    if (!marketResult.ok) {
      reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
      return { error: marketResult.error.code, message: marketResult.error.message };
    }

    const tokenIds = parseTokenIds(marketResult.value.clobTokenIds);
    const outcomeIdx = q["outcome"] !== undefined ? Number(q["outcome"]) : 0;
    // ?tokenId= addresses an outcome directly (the builder knows tokenIds, not
    // indices); it must belong to this market, else fall back to the index.
    const requestedToken = q["tokenId"];
    const tokenId =
      requestedToken !== undefined && tokenIds.includes(requestedToken)
        ? requestedToken
        : (tokenIds[outcomeIdx] ?? tokenIds[0]);

    if (tokenId === undefined) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "No token ID for this market" };
    }

    const snapshot = await deps.marketSnapshots.findByTokenId(tokenId);
    if (snapshot !== null) {
      return {
        tokenId,
        bids: snapshot.bids,
        asks: snapshot.asks,
        isStale: snapshot.isStale,
        source: snapshot.source,
        receivedAt: snapshot.receivedAt,
      };
    }

    const obResult = await deps.clobClient.getOrderbook(tokenId);
    if (!obResult.ok) {
      reply.code(502);
      return { error: obResult.error.code, message: obResult.error.message };
    }

    return {
      tokenId,
      bids: obResult.value.bids,
      asks: obResult.value.asks,
      isStale: false,
      source: "rest",
      receivedAt: new Date().toISOString(),
    };
  });

  // Recent public trades in the market (Data API, taker fills, most recent
  // first). PUBLIC + rate-limited; the web polls this on the cockpit.
  app.get(
    "/api/markets/:id/trades",
    { preHandler: [makeRateLimit({ scope: "market-trades", limit: 60, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string>;

      const marketResult = await deps.gammaClient.getMarket(id);
      if (!marketResult.ok) {
        reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
        return { error: marketResult.error.code, message: marketResult.error.message };
      }
      const conditionId = marketResult.value.conditionId;

      const limitRaw = q["limit"] !== undefined ? Number(q["limit"]) : 25;
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
        : 25;
      const tradesResult = await deps.dataClient.getMarketTrades({ conditionId, limit });
      if (!tradesResult.ok) {
        reply.code(502);
        return { error: tradesResult.error.code, message: tradesResult.error.message };
      }

      return {
        conditionId,
        trades: tradesResult.value.map((t) => ({
          side: t.side,
          price: t.price,
          size: t.size,
          timestamp: t.timestamp,
          outcome: t.outcome ?? null,
          outcomeIndex: t.outcomeIndex ?? null,
          name: t.name || t.pseudonym || null,
          proxyWallet: t.proxyWallet,
          transactionHash: t.transactionHash ?? null,
        })),
      };
    },
  );

  // Top holders per outcome token (Data API). PUBLIC + rate-limited.
  app.get(
    "/api/markets/:id/holders",
    { preHandler: [makeRateLimit({ scope: "market-holders", limit: 30, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string>;

      const marketResult = await deps.gammaClient.getMarket(id);
      if (!marketResult.ok) {
        reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
        return { error: marketResult.error.code, message: marketResult.error.message };
      }
      const conditionId = marketResult.value.conditionId;
      const tokenIds = parseTokenIds(marketResult.value.clobTokenIds);
      const outcomes = ((): string[] => {
        try {
          const arr: unknown = JSON.parse(marketResult.value.outcomes);
          return Array.isArray(arr) ? arr.map(String) : [];
        } catch {
          return [];
        }
      })();

      const limitRaw = q["limit"] !== undefined ? Number(q["limit"]) : 10;
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20)
        : 10;
      const holdersResult = await deps.dataClient.getHolders({ conditionId, limit });
      if (!holdersResult.ok) {
        reply.code(502);
        return { error: holdersResult.error.code, message: holdersResult.error.message };
      }

      return {
        conditionId,
        groups: holdersResult.value.map((g) => {
          const idx = tokenIds.indexOf(g.token);
          return {
            tokenId: g.token,
            outcome: idx >= 0 ? (outcomes[idx] ?? `Outcome ${idx + 1}`) : null,
            holders: g.holders.slice(0, limit).map((h) => ({
              proxyWallet: h.proxyWallet,
              name: h.name || h.pseudonym || null,
              amount: h.amount,
              profileImage: h.profileImage ?? null,
            })),
          };
        }),
      };
    },
  );

  // Backtested "how you could enter this market" scenarios (?outcome=0|1).
  // PUBLIC + rate-limited; 15-min per-market cache inside getMarketScenarios.
  app.get(
    "/api/markets/:id/scenarios",
    { preHandler: [makeRateLimit({ scope: "market-scenarios", limit: 30, windowMs: 60_000 })] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string>;

      const marketResult = await deps.gammaClient.getMarket(id);
      if (!marketResult.ok) {
        reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
        return { error: marketResult.error.code, message: marketResult.error.message };
      }
      const market = marketResult.value;
      const tokenIds = parseTokenIds(market.clobTokenIds);
      const outcomeIdx = q["outcome"] !== undefined ? Number(q["outcome"]) : 0;
      const tokenId = tokenIds[outcomeIdx] ?? tokenIds[0];
      if (tokenId === undefined) {
        reply.code(404);
        return { error: "NOT_FOUND", message: "No token ID for this market" };
      }
      const outcomes = ((): string[] => {
        try {
          const arr: unknown = JSON.parse(market.outcomes);
          return Array.isArray(arr) ? arr.map(String) : [];
        } catch {
          return [];
        }
      })();

      const prices = ((): number[] => {
        try {
          const arr: unknown = JSON.parse(market.outcomePrices);
          return Array.isArray(arr) ? arr.map(Number) : [];
        } catch {
          return [];
        }
      })();
      const bid = Number(market.bestBid);
      const ask = Number(market.bestAsk);
      const currentPrice =
        Number.isFinite(prices[outcomeIdx]) && prices[outcomeIdx]! > 0
          ? prices[outcomeIdx]!
          : bid > 0 && ask > 0
            ? (bid + ask) / 2
            : NaN;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || currentPrice >= 1) {
        return {
          conditionId: market.conditionId,
          outcome: outcomes[outcomeIdx] ?? "Yes",
          generatedAt: new Date().toISOString(),
          scenarios: [],
        };
      }

      try {
        return await getMarketScenarios(
          {
            clobClient: deps.clobClient,
            // Reuses the 5-min economics cache; a miss only drops the farm card.
            getRewards: async (conditionId) => {
              const eco = await getMarketEconomics(deps, conditionId);
              return eco.rewards
                ? { ratePerDayUsd: eco.rewards.ratePerDayUsd, minSize: eco.rewards.minSize }
                : null;
            },
            makerLoopEnabled: deps.makerLoopEnabled ?? false,
          },
          {
            conditionId: market.conditionId,
            tokenId,
            outcome: outcomes[outcomeIdx] ?? "Yes",
            title: market.question,
            currentPrice,
          },
          req.log,
        );
      } catch (e) {
        reply.code(502);
        return {
          error: "SCENARIOS_UNAVAILABLE",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  // Price history from the CLOB API, keyed by the outcome's CLOB token id
  // (?outcome=0 default YES, 1 NO). The conditionId does NOT work here.
  app.get("/api/markets/:id/prices-history", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;

    const marketResult = await deps.gammaClient.getMarket(id);
    if (!marketResult.ok) {
      reply.code(marketResult.error.statusCode === 404 ? 404 : 502);
      return { error: marketResult.error.code, message: marketResult.error.message };
    }

    const tokenIds = parseTokenIds(marketResult.value.clobTokenIds);
    const outcomeIdx = q["outcome"] !== undefined ? Number(q["outcome"]) : 0;
    const tokenId = tokenIds[outcomeIdx] ?? tokenIds[0];
    if (tokenId === undefined) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "No token ID for this market" };
    }

    const histParams: GetPricesHistoryParams = { tokenId };
    if (q["startTs"] !== undefined) histParams.startTs = Number(q["startTs"]);
    if (q["endTs"] !== undefined) histParams.endTs = Number(q["endTs"]);
    if (q["fidelity"] !== undefined) histParams.fidelity = Number(q["fidelity"]);
    if (q["interval"] !== undefined) histParams.interval = q["interval"];
    const histResult = await deps.clobClient.getPricesHistory(histParams);

    if (!histResult.ok) {
      reply.code(502);
      return { error: histResult.error.code, message: histResult.error.message };
    }

    return { conditionId: marketResult.value.conditionId, tokenId, history: histResult.value };
  });
};
