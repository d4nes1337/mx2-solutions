import type { FastifyInstance } from "fastify";
import type { GammaClient, GammaEvent, PolymarketError } from "@mx2/polymarket-client";
import { getInstantMarkets } from "../lib/instant-markets.js";
import { makeRateLimit } from "../middleware/rate-limit.js";

/**
 * Markets browse: a thin pass-through over Gamma /events/pagination — the same
 * endpoint polymarket.com's homepage grid pages through — so the Markets tab
 * shows the same markets in the same order (active, open, volume24hr desc),
 * with real offset pagination for infinite scroll.
 */
export interface BrowseRoutesDeps {
  gammaClient: GammaClient;
}

export interface BrowsePage {
  events: GammaEvent[];
  hasMore: boolean;
  totalResults: number;
  offset: number;
  limit: number;
  /** True when this is a stale cache entry served because Gamma failed. */
  degraded: boolean;
}

const FRESH_TTL_MS = 20_000;
/** How long a last-good page may be served after Gamma starts failing. */
const STALE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 100;
const MAX_LIMIT = 50;
const MAX_OFFSET = 1000;
const TAG_RE = /^[a-z0-9-]{1,60}$/;

interface CacheEntry {
  at: number;
  page: BrowsePage;
}

type FetchOutcome = { ok: true; page: BrowsePage } | { ok: false; error: PolymarketError };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<FetchOutcome>>();

/** Test hook. */
export const resetBrowseCache = (): void => {
  cache.clear();
  inflight.clear();
};

const remember = (key: string, page: BrowsePage): void => {
  cache.delete(key);
  cache.set(key, { at: Date.now(), page });
  // Insertion-order eviction is enough here: entries are tiny and short-lived.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

export const registerBrowseRoutes = (app: FastifyInstance, deps: BrowseRoutesDeps): void => {
  const browseGuard = makeRateLimit({ scope: "browse", limit: 60, windowMs: 60_000 });

  app.get("/api/markets/browse", { preHandler: browseGuard }, async (req, reply) => {
    const q = req.query as Record<string, string>;

    const limitRaw = q["limit"] !== undefined ? Number(q["limit"]) : 20;
    const offsetRaw = q["offset"] !== undefined ? Number(q["offset"]) : 0;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: `limit must be an integer 1–${MAX_LIMIT}.` };
    }
    if (!Number.isInteger(offsetRaw) || offsetRaw < 0 || offsetRaw > MAX_OFFSET) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: `offset must be an integer 0–${MAX_OFFSET}.` };
    }
    const tag = (q["tag"] ?? "").trim();
    if (tag !== "" && !TAG_RE.test(tag)) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "tag must be a lowercase slug." };
    }

    const key = `${tag}:${offsetRaw}:${limitRaw}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < FRESH_TTL_MS) return hit.page;

    let job = inflight.get(key);
    if (!job) {
      job = (async (): Promise<FetchOutcome> => {
        const result = await deps.gammaClient.listEventsPaginated({
          limit: limitRaw,
          offset: offsetRaw,
          active: true,
          closed: false,
          archived: false,
          order: "volume24hr",
          ascending: false,
          ...(tag !== "" ? { tag_slug: tag } : {}),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const page: BrowsePage = {
          events: result.value.data,
          hasMore: result.value.pagination.hasMore,
          totalResults: result.value.pagination.totalResults,
          offset: offsetRaw,
          limit: limitRaw,
          degraded: false,
        };
        remember(key, page);
        return { ok: true, page };
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }

    const outcome = await job;
    if (outcome.ok) return outcome.page;

    // Upstream failed: serve the last good page (marked degraded) if recent
    // enough, otherwise surface the failure.
    if (hit && now - hit.at < STALE_TTL_MS) return { ...hit.page, degraded: true };
    reply.code(outcome.error.statusCode === 429 ? 429 : 502);
    return { error: outcome.error.code, message: outcome.error.message };
  });

  // ── GET /api/markets/instant — curated recurring series, live + next windows ─
  // Caching (15s single shared entry, stale-on-error) lives in the lib module.
  const instantGuard = makeRateLimit({ scope: "instant", limit: 60, windowMs: 60_000 });
  app.get("/api/markets/instant", { preHandler: instantGuard }, async (_req, reply) => {
    const result = await getInstantMarkets(deps.gammaClient);
    if (!result.ok) {
      reply.code(result.error.statusCode === 429 ? 429 : 502);
      return { error: result.error.code, message: result.error.message };
    }
    return result.value;
  });
};
