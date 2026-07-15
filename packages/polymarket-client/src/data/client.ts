import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import {
  ActivitySchema,
  ClosedPositionSchema,
  LeaderboardEntrySchema,
  MarketHoldersGroupSchema,
  MarketTradeSchema,
  PositionSchema,
  PositionValueSchema,
  type Activity,
  type ClosedPosition,
  type LeaderboardEntry,
  type MarketHoldersGroup,
  type MarketTrade,
  type Position,
  type PositionValue,
} from "./schema.js";
import {
  networkError,
  upstreamError,
  parseError,
  timeoutError,
  rateLimitError,
  type PolymarketError,
} from "../errors.js";

export interface GetPositionsParams {
  user: string;
  sizeThreshold?: number;
  limit?: number;
  offset?: number;
}

export interface GetActivityParams {
  user: string;
  limit?: number;
  offset?: number;
  start?: number;
  end?: number;
  type?: string;
  sortDirection?: "ASC" | "DESC";
}

export interface GetClosedPositionsParams {
  user: string;
  limit?: number;
  offset?: number;
  sortBy?: "REALIZEDPNL" | "TITLE" | "PRICE" | "AVGPRICE" | "TIMESTAMP";
  sortDirection?: "ASC" | "DESC";
}

export interface GetLeaderboardParams {
  user: string;
  category?:
    | "OVERALL"
    | "POLITICS"
    | "SPORTS"
    | "ESPORTS"
    | "CRYPTO"
    | "CULTURE"
    | "MENTIONS"
    | "WEATHER"
    | "ECONOMICS"
    | "TECH"
    | "FINANCE";
  timePeriod?: "DAY" | "WEEK" | "MONTH" | "ALL";
  orderBy?: "PNL" | "VOL";
}

export interface GetMarketTradesParams {
  /** Market condition id (0x…). */
  conditionId: string;
  limit?: number;
  /** Default true upstream — taker fills only (one row per trade). */
  takerOnly?: boolean;
}

export interface GetHoldersParams {
  /** Market condition id (0x…). */
  conditionId: string;
  /** Upstream default 20, max 20 per token. */
  limit?: number;
}

export interface DataClient {
  getPositions(params: GetPositionsParams): Promise<Result<Position[], PolymarketError>>;
  /** Recent public trades in a market (Data API /trades, most recent first). */
  getMarketTrades(params: GetMarketTradesParams): Promise<Result<MarketTrade[], PolymarketError>>;
  /** Top holders per outcome token (Data API /holders). */
  getHolders(params: GetHoldersParams): Promise<Result<MarketHoldersGroup[], PolymarketError>>;
  getClosedPositions(
    params: GetClosedPositionsParams,
  ): Promise<Result<ClosedPosition[], PolymarketError>>;
  getActivity(params: GetActivityParams): Promise<Result<Activity[], PolymarketError>>;
  getPositionValue(params: {
    user: string;
  }): Promise<Result<PositionValue | null, PolymarketError>>;
  getLeaderboardEntry(
    params: GetLeaderboardParams,
  ): Promise<Result<LeaderboardEntry | null, PolymarketError>>;
}

export interface DataClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

type SafeParser<T> = {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
};

const buildUrl = (base: string, path: string, params: Record<string, string>): string => {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
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

const DEFAULT_BASE_URL = "https://data-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export const createDataClient = (opts?: DataClientOptions): DataClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    getPositions(params) {
      const q: Record<string, string> = { user: params.user };
      if (params.sizeThreshold !== undefined) q["sizeThreshold"] = String(params.sizeThreshold);
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      if (params.offset !== undefined) q["offset"] = String(params.offset);
      return fetchJson(buildUrl(baseUrl, "/positions", q), PositionSchema.array(), timeoutMs);
    },

    getMarketTrades(params) {
      const q: Record<string, string> = { market: params.conditionId };
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      if (params.takerOnly !== undefined) q["takerOnly"] = String(params.takerOnly);
      return fetchJson(buildUrl(baseUrl, "/trades", q), MarketTradeSchema.array(), timeoutMs);
    },

    getHolders(params) {
      const q: Record<string, string> = { market: params.conditionId };
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      return fetchJson(
        buildUrl(baseUrl, "/holders", q),
        MarketHoldersGroupSchema.array(),
        timeoutMs,
      );
    },

    getClosedPositions(params) {
      const q: Record<string, string> = { user: params.user };
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      if (params.offset !== undefined) q["offset"] = String(params.offset);
      if (params.sortBy !== undefined) q["sortBy"] = params.sortBy;
      if (params.sortDirection !== undefined) q["sortDirection"] = params.sortDirection;
      return fetchJson(
        buildUrl(baseUrl, "/closed-positions", q),
        ClosedPositionSchema.array(),
        timeoutMs,
      );
    },

    getActivity(params) {
      const q: Record<string, string> = { user: params.user };
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      if (params.offset !== undefined) q["offset"] = String(params.offset);
      if (params.start !== undefined) q["start"] = String(params.start);
      if (params.end !== undefined) q["end"] = String(params.end);
      if (params.type !== undefined) q["type"] = params.type;
      if (params.sortDirection !== undefined) q["sortDirection"] = params.sortDirection;
      return fetchJson(buildUrl(baseUrl, "/activity", q), ActivitySchema.array(), timeoutMs);
    },

    async getPositionValue(params) {
      const result = await fetchJson(
        buildUrl(baseUrl, "/value", { user: params.user }),
        PositionValueSchema.array(),
        timeoutMs,
      );
      if (!result.ok) return result;
      return ok(result.value[0] ?? null);
    },

    async getLeaderboardEntry(params) {
      const q: Record<string, string> = {
        user: params.user,
        category: params.category ?? "OVERALL",
        timePeriod: params.timePeriod ?? "ALL",
        orderBy: params.orderBy ?? "PNL",
        limit: "1",
      };
      const result = await fetchJson(
        buildUrl(baseUrl, "/v1/leaderboard", q),
        LeaderboardEntrySchema.array(),
        timeoutMs,
      );
      if (!result.ok) return result;
      return ok(result.value[0] ?? null);
    },
  };
};
