import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Minimal sliding-window per-IP rate limiter for the PUBLIC Smart Orders
 * endpoints (draft evaluation, market search). In-memory by design: the API is
 * a single process (D-001), the window is short, and losing counts on restart
 * is acceptable — this is an abuse brake, not an accounting system. Swap for a
 * shared store if the API ever runs multi-instance.
 */
export interface RateLimitOptions {
  /** Max requests per window per client. */
  limit: number;
  windowMs: number;
  /** Distinguishes buckets when several routes share one limiter map. */
  scope: string;
}

const hits = new Map<string, number[]>();
const MAX_KEYS = 10_000;

/** Test hook. */
export const resetRateLimits = (): void => {
  hits.clear();
};

export const makeRateLimit = (opts: RateLimitOptions) => {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    const key = `${opts.scope}:${req.ip}`;

    const windowStart = now - opts.windowMs;
    const bucket = (hits.get(key) ?? []).filter((t) => t > windowStart);

    if (bucket.length >= opts.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket[0]! + opts.windowMs - now) / 1000));
      await reply
        .code(429)
        .header("retry-after", String(retryAfterSec))
        .send({
          error: "RATE_LIMITED",
          message: `Too many requests — try again in ${retryAfterSec}s.`,
        });
      return;
    }

    bucket.push(now);
    hits.set(key, bucket);

    // Opportunistic bound on the map so a scan of spoofed IPs can't grow it
    // forever; evicting whole buckets only ever under-counts (fails open on
    // rate, never on correctness).
    if (hits.size > MAX_KEYS) {
      for (const k of hits.keys()) {
        if (hits.size <= MAX_KEYS / 2) break;
        hits.delete(k);
      }
    }
  };
};
