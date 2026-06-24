import { z } from "zod";
import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import {
  OrderbookSchema,
  TradeSchema,
  TokenPriceSchema,
  LastTradePriceSchema,
  type Orderbook,
  type Trade,
  type TokenPrice,
} from "./schema.js";
import { PricePointSchema, type PricePoint } from "../gamma/schema.js";
import {
  networkError,
  upstreamError,
  parseError,
  timeoutError,
  rateLimitError,
  type PolymarketError,
} from "../errors.js";

export interface GetTradesParams {
  conditionId: string;
  limit?: number;
}

export interface GetPricesHistoryParams {
  /** CLOB token id (clobTokenIds[outcomeIndex]) — NOT the conditionId. */
  tokenId: string;
  startTs?: number;
  endTs?: number;
  /** Resolution in minutes (defaults to 60). */
  fidelity?: number;
  /** Time window when startTs/endTs are not given: max | 1m | 1w | 1d | 6h | 1h. */
  interval?: string;
}

export interface ClobClient {
  getOrderbook(tokenId: string): Promise<Result<Orderbook, PolymarketError>>;
  getTrades(params: GetTradesParams): Promise<Result<Trade[], PolymarketError>>;
  getPrices(tokenIds: string[]): Promise<Result<TokenPrice[], PolymarketError>>;
  getLastTradePrice(tokenId: string): Promise<Result<string, PolymarketError>>;
  getPricesHistory(params: GetPricesHistoryParams): Promise<Result<PricePoint[], PolymarketError>>;
}

// The CLOB price-history endpoint wraps the series in a `history` object:
// { history: [{ t, p }, ...] }. (The earlier code hit the Gamma host with a
// bare-array schema and the conditionId, which 404'd / returned nothing.)
const PricesHistoryResponseSchema = z
  .object({ history: PricePointSchema.array().default([]) })
  .passthrough();

export interface ClobClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

type SafeParser<T> = {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
};

const fetchJson = async <T>(
  url: string,
  schema: SafeParser<T>,
  timeoutMs: number,
): Promise<Result<T, PolymarketError>> => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) return err(rateLimitError());
      return err(upstreamError(response.status, `HTTP ${response.status}`));
    }
    const json: unknown = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) return err(parseError(parsed.error.message));
    return ok(parsed.data);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return err(timeoutError());
    return err(networkError(e instanceof Error ? e.message : String(e), e));
  } finally {
    clearTimeout(timerId);
  }
};

const DEFAULT_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export const createClobClient = (opts?: ClobClientOptions): ClobClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    getOrderbook: (tokenId) => {
      const url = new URL("/book", baseUrl);
      url.searchParams.set("token_id", tokenId);
      return fetchJson(url.toString(), OrderbookSchema, timeoutMs);
    },

    getTrades: (params) => {
      const url = new URL("/trades", baseUrl);
      url.searchParams.set("market", params.conditionId);
      url.searchParams.set("limit", String(params.limit ?? 20));
      return fetchJson(url.toString(), TradeSchema.array(), timeoutMs);
    },

    getPrices: async (tokenIds) => {
      if (tokenIds.length === 0) return ok([]);
      const url = new URL("/prices", baseUrl);
      url.searchParams.set("token_ids_csv", tokenIds.join(","));
      return fetchJson(url.toString(), TokenPriceSchema.array(), timeoutMs);
    },

    getLastTradePrice: async (tokenId) => {
      const url = new URL("/last-trade-price", baseUrl);
      url.searchParams.set("token_id", tokenId);
      const result = await fetchJson(url.toString(), LastTradePriceSchema, timeoutMs);
      if (!result.ok) return err(result.error);
      return ok(result.value.price);
    },

    getPricesHistory: async (params) => {
      const url = new URL("/prices-history", baseUrl);
      url.searchParams.set("market", params.tokenId);
      if (params.startTs !== undefined) url.searchParams.set("startTs", String(params.startTs));
      if (params.endTs !== undefined) url.searchParams.set("endTs", String(params.endTs));
      // The endpoint requires a window: explicit start/end OR an interval.
      // Default to the full history ("max") when no explicit window is given.
      if (params.startTs === undefined && params.endTs === undefined) {
        url.searchParams.set("interval", params.interval ?? "max");
      } else if (params.interval !== undefined) {
        url.searchParams.set("interval", params.interval);
      }
      url.searchParams.set("fidelity", String(params.fidelity ?? 60));
      const result = await fetchJson(url.toString(), PricesHistoryResponseSchema, timeoutMs);
      if (!result.ok) return err(result.error);
      return ok(result.value.history);
    },
  };
};
