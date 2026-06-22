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

export interface ClobClient {
  getOrderbook(tokenId: string): Promise<Result<Orderbook, PolymarketError>>;
  getTrades(params: GetTradesParams): Promise<Result<Trade[], PolymarketError>>;
  getPrices(tokenIds: string[]): Promise<Result<TokenPrice[], PolymarketError>>;
  getLastTradePrice(tokenId: string): Promise<Result<string, PolymarketError>>;
}

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
  };
};
