import type { Logger } from "@mx2/observability";
import type { PriceSample } from "@mx2/rules";
import type { PriceWindowStore } from "./price-window.js";

/**
 * Seeds `price_move` windows from upstream price history so a strategy is
 * never structurally blind for its full lookback after arm, worker restart,
 * or a WS reconnect (the incident class: a 10¢-in-1m drop 40s after arming
 * was invisible because the in-memory window needed 60s of live samples
 * before it could evaluate at all).
 *
 * Fail-closed by construction: a seed only ADDS history behind live data
 * (PriceWindowStore.merge never lets a seed become the newest sample), so it
 * can reveal a real move earlier but never fabricate one, and a failed seed
 * just leaves the window incomplete — exactly today's behavior.
 */
export interface PriceSeeder {
  /**
   * Fetch + merge history for one token. Fire-and-forget friendly (never
   * rejects). Single-flight per token; successful seeds are not repeated
   * within `minReseedIntervalMs` unless `force` (reconnect gap-heal) is set.
   */
  seedToken(tokenId: string, lookbackMs: number, opts?: { force?: boolean }): Promise<void>;
}

export interface PriceSeederOptions {
  logger: Logger;
  priceWindows: PriceWindowStore;
  /** Normalized (ms timestamps, oldest-first, p∈(0,1)) trailing history. */
  fetchPriceHistory: (
    tokenId: string,
    lookbackMs: number,
  ) => Promise<readonly PriceSample[] | null>;
  /** Quiet period after a successful seed before a non-forced repeat. Default 30 s. */
  minReseedIntervalMs?: number;
  /** Backoff after a failed fetch. Default 15 s. */
  errorBackoffMs?: number;
}

export const createPriceSeeder = (opts: PriceSeederOptions): PriceSeeder => {
  const { logger, priceWindows, fetchPriceHistory } = opts;
  const minReseedIntervalMs = opts.minReseedIntervalMs ?? 30_000;
  const errorBackoffMs = opts.errorBackoffMs ?? 15_000;

  const inFlight = new Map<string, Promise<void>>();
  const seededAt = new Map<string, number>();
  const backoffUntil = new Map<string, number>();

  return {
    seedToken(tokenId, lookbackMs, seedOpts) {
      const existing = inFlight.get(tokenId);
      if (existing) return existing;
      const now = Date.now();
      if (!seedOpts?.force) {
        if ((backoffUntil.get(tokenId) ?? 0) > now) return Promise.resolve();
        // The recency skip only holds while the buffer still HAS the seeded
        // data. A dropped buffer (rule re-added after crash recovery,
        // pause/resume, edit) must reseed immediately or the window is blind
        // for a full windowMs again.
        const hasData = priceWindows.history(tokenId) !== undefined;
        if (hasData && now - (seededAt.get(tokenId) ?? -Infinity) < minReseedIntervalMs) {
          return Promise.resolve();
        }
      }
      const run = (async () => {
        try {
          const samples = await fetchPriceHistory(tokenId, lookbackMs);
          if (samples === null) {
            backoffUntil.set(tokenId, Date.now() + errorBackoffMs);
            logger.warn({ tokenId, lookbackMs }, "Price-window seed returned no history");
            return;
          }
          priceWindows.merge(tokenId, samples);
          seededAt.set(tokenId, Date.now());
          backoffUntil.delete(tokenId);
          logger.debug(
            { tokenId, lookbackMs, samples: samples.length },
            "Price-window seeded from history",
          );
        } catch (e) {
          backoffUntil.set(tokenId, Date.now() + errorBackoffMs);
          logger.warn({ err: e, tokenId, lookbackMs }, "Price-window seed failed");
        } finally {
          inFlight.delete(tokenId);
        }
      })();
      inFlight.set(tokenId, run);
      return run;
    },
  };
};
