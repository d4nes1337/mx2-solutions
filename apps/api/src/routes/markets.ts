import type { FastifyInstance } from "fastify";
import type { GammaClient, ClobClient, GetPricesHistoryParams } from "@mx2/polymarket-client";
import type { MarketSnapshotStore } from "@mx2/db";
import { makeRateLimit } from "../middleware/rate-limit.js";

export interface MarketsRoutesDeps {
  gammaClient: GammaClient;
  clobClient: ClobClient;
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
