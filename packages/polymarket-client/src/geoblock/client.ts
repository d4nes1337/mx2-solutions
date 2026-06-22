import type { Result } from "@mx2/core";
import { ok, err } from "@mx2/core";
import { GeoblockResponseSchema, type GeoblockResult, type GeoblockStatus } from "./schema.js";
import {
  networkError,
  timeoutError,
  upstreamError,
  parseError,
  type PolymarketError,
} from "../errors.js";

// From docs/INTEGRATION_VERIFIED.md §8. Re-verify before live trading gate.
const CLOSE_ONLY_COUNTRIES = new Set(["PL", "SG", "TH", "TW"]);

export interface GeoblockClient {
  check(ip: string): Promise<Result<GeoblockResult, PolymarketError>>;
}

export interface GeoblockClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

const DEFAULT_BASE_URL = "https://polymarket.com/api/geoblock";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

export const createGeoblockClient = (opts?: GeoblockClientOptions): GeoblockClient => {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // In-memory cache keyed by IP. Entries expire after cacheTtlMs.
  const cache = new Map<string, { result: GeoblockResult; expiresAt: number }>();

  const resolve = (
    country: string,
    region: string | null,
    ip: string,
    rawBlocked: boolean,
  ): GeoblockResult => {
    let status: GeoblockStatus;
    if (rawBlocked) {
      status = "blocked";
    } else if (CLOSE_ONLY_COUNTRIES.has(country.toUpperCase())) {
      status = "close_only";
    } else {
      status = "allowed";
    }
    return { status, country: country.toUpperCase(), region: region ?? null, ip };
  };

  return {
    async check(ip) {
      const cached = cache.get(ip);
      if (cached && cached.expiresAt > Date.now()) {
        return ok(cached.result);
      }

      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(baseUrl, { signal: controller.signal });
        if (!response.ok) {
          // Fail-closed: treat upstream error as blocked.
          return err(upstreamError(response.status, `geoblock HTTP ${response.status}`));
        }
        const json: unknown = await response.json();
        const parsed = GeoblockResponseSchema.safeParse(json);
        if (!parsed.success) return err(parseError(parsed.error.message));

        const result = resolve(
          parsed.data.country,
          parsed.data.region ?? null,
          parsed.data.ip,
          parsed.data.blocked,
        );
        cache.set(ip, { result, expiresAt: Date.now() + cacheTtlMs });
        return ok(result);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return err(timeoutError());
        return err(networkError(e instanceof Error ? e.message : String(e), e));
      } finally {
        clearTimeout(timerId);
      }
    },
  };
};
