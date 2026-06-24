import type { FastifyInstance } from "fastify";
import type { GammaClient, ClobClient, GetPricesHistoryParams } from "@mx2/polymarket-client";
import type { MarketSnapshotStore } from "@mx2/db";

export interface MarketsRoutesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
  marketSnapshots: MarketSnapshotStore;
}

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
