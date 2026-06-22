import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import { PositionSchema, ActivitySchema, type Position, type Activity } from "./schema.js";
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
}

export interface GetActivityParams {
  user: string;
  limit?: number;
}

export interface DataClient {
  getPositions(params: GetPositionsParams): Promise<Result<Position[], PolymarketError>>;
  getActivity(params: GetActivityParams): Promise<Result<Activity[], PolymarketError>>;
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
      return fetchJson(buildUrl(baseUrl, "/positions", q), PositionSchema.array(), timeoutMs);
    },

    getActivity(params) {
      const q: Record<string, string> = { user: params.user };
      if (params.limit !== undefined) q["limit"] = String(params.limit);
      return fetchJson(buildUrl(baseUrl, "/activity", q), ActivitySchema.array(), timeoutMs);
    },
  };
};
