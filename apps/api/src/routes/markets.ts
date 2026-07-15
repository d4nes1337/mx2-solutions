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

export interface MarketsRoutesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
  dataClient: DataClient;
  marketSnapshots: MarketSnapshotStore;
}

// CLOB token ids are uint256 rendered as decimal strings.
const TOKEN_ID_RE = /^\d{1,100}$/;

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
    const tokenId = tokenIds[outcomeIdx] ?? tokenIds[0];

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
          { clobClient: deps.clobClient },
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
