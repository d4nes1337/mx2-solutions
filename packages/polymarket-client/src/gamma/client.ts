import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import {
  GammaEventSchema,
  GammaMarketSchema,
  type GammaEvent,
  type GammaMarket,
} from "./schema.js";
import {
  networkError,
  upstreamError,
  parseError,
  timeoutError,
  rateLimitError,
  type PolymarketError,
} from "../errors.js";

export interface ListEventsParams {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  order?: string;
  ascending?: boolean;
}

export interface ListMarketsParams {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
}

export interface GammaClient {
  listEvents(params?: ListEventsParams): Promise<Result<GammaEvent[], PolymarketError>>;
  getEvent(id: string): Promise<Result<GammaEvent, PolymarketError>>;
  listMarkets(params?: ListMarketsParams): Promise<Result<GammaMarket[], PolymarketError>>;
  getMarket(id: string): Promise<Result<GammaMarket, PolymarketError>>;
}

export interface GammaClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

type SafeParser<T> = {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
};

const buildUrl = (
  base: string,
  path: string,
  params?: Record<string, string | number | boolean>,
): string => {
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
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

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export const createGammaClient = (opts?: GammaClientOptions): GammaClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const buildParams = (
    raw: Record<string, string | number | boolean | undefined | null>,
  ): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  };

  return {
    listEvents: (params) =>
      fetchJson(
        buildUrl(
          baseUrl,
          "/events",
          buildParams({
            limit: params?.limit ?? 20,
            offset: params?.offset ?? 0,
            active: params?.active,
            closed: params?.closed,
            order: params?.order,
            ascending: params?.ascending,
          }),
        ),
        GammaEventSchema.array(),
        timeoutMs,
      ),

    getEvent: (id) =>
      fetchJson(
        buildUrl(baseUrl, `/events/${encodeURIComponent(id)}`),
        GammaEventSchema,
        timeoutMs,
      ),

    listMarkets: (params) =>
      fetchJson(
        buildUrl(
          baseUrl,
          "/markets",
          buildParams({
            limit: params?.limit ?? 20,
            offset: params?.offset ?? 0,
            active: params?.active,
            closed: params?.closed,
          }),
        ),
        GammaMarketSchema.array(),
        timeoutMs,
      ),

    getMarket: (id) =>
      fetchJson(
        buildUrl(baseUrl, `/markets/${encodeURIComponent(id)}`),
        GammaMarketSchema,
        timeoutMs,
      ),
  };
};
