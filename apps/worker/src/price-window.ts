import type { PriceSample } from "@mx2/rules";

/**
 * Per-token rolling price windows feeding `price_move` conditions.
 *
 * Memory bounds: samples older than HORIZON_MS (the max validated lookback,
 * PRICE_MOVE_WINDOW_MAX_MS, plus a grace band so a carry-in sample survives)
 * are evicted on push, with one sample always retained at/before the horizon
 * (the engine's coverage rule needs it). A hard cap of MAX_SAMPLES per token
 * (≈2 samples/second for the full hour) bounds bursty tapes; with the
 * evaluator's 4-markets-per-rule cap this stays a few hundred KB per token
 * worst case.
 *
 * Continuity semantics: buffers fill from live ticks AND from `merge`d
 * seed history (CLOB /prices-history bars), so a freshly-armed strategy or a
 * post-reconnect window is blind only until one seed round-trip, not for a
 * full windowMs. `markGap` handles a broken feed: everything at/before the
 * gap is discarded (a carry-in must never silently span a dark period), and
 * the seeder backfills the gap from upstream history — which is authoritative
 * for what the market really did while we were dark. A merged sample is never
 * allowed to supersede or postdate live observations: live data always wins
 * on timestamp collisions, and seeds insert strictly BEFORE the newest live
 * sample whenever one exists, so `last` in the move computation is a live
 * observation the moment any live tick lands.
 */
const HORIZON_MS = 3_600_000 + 300_000; // PRICE_MOVE_WINDOW_MAX_MS + 5 min grace
const MAX_SAMPLES = 7_200;

interface TokenBuffer {
  samples: PriceSample[];
  /** Cached immutable snapshot, invalidated on every mutation. */
  snapshot: readonly PriceSample[] | null;
}

export interface PriceWindowStore {
  push(tokenId: string, price: number, tMs: number): void;
  /**
   * Backfill history (seed bars) into the token's buffer. Existing samples win
   * timestamp collisions; when live samples exist, only strictly-older seeds
   * are inserted (a seed can never become the newest sample).
   */
  merge(tokenId: string, samples: readonly PriceSample[]): void;
  /**
   * Feed continuity broke at `atMs` (WS reconnect): discard everything
   * at/before it so a stale carry-in can never masquerade as a fresh move.
   * The window is incomplete (fail-closed) until reseeded or refilled.
   */
  markGap(tokenId: string, atMs: number): void;
  /** Oldest-first samples for the token (cached between mutations). */
  history(tokenId: string): readonly PriceSample[] | undefined;
  /** Drop one token's buffer (unsubscribed). */
  drop(tokenId: string): void;
  /** Wipe everything (shutdown/tests). */
  clear(): void;
  /** Number of tracked tokens (observability/tests). */
  size(): number;
}

/** Evict beyond the horizon (keeping ONE carry-in sample) and cap the buffer. */
const evict = (samples: PriceSample[], newestTMs: number): void => {
  const cutoff = newestTMs - HORIZON_MS;
  let firstInside = 0;
  while (firstInside < samples.length && samples[firstInside]!.t <= cutoff) {
    firstInside++;
  }
  const keepFrom = Math.max(0, firstInside - 1);
  if (keepFrom > 0) samples.splice(0, keepFrom);
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
};

export const createPriceWindowStore = (): PriceWindowStore => {
  const buffers = new Map<string, TokenBuffer>();

  const bufferFor = (tokenId: string): TokenBuffer => {
    let buf = buffers.get(tokenId);
    if (!buf) {
      buf = { samples: [], snapshot: null };
      buffers.set(tokenId, buf);
    }
    return buf;
  };

  return {
    push(tokenId, price, tMs) {
      if (!Number.isFinite(price) || price <= 0 || price >= 1) return;
      const buf = bufferFor(tokenId);
      // Out-of-order guard: ignore samples older than the newest one (WS
      // batches arrive in order; anything else is clock noise).
      const newest = buf.samples[buf.samples.length - 1];
      if (newest && tMs < newest.t) return;
      buf.samples.push({ t: tMs, p: price });
      evict(buf.samples, tMs);
      buf.snapshot = null;
    },

    merge(tokenId, incoming) {
      const clean = incoming.filter(
        (s) => Number.isFinite(s.t) && Number.isFinite(s.p) && s.p > 0 && s.p < 1,
      );
      if (clean.length === 0) return;
      const buf = bufferFor(tokenId);
      const newest = buf.samples[buf.samples.length - 1];
      // Live data wins: seeds only land strictly before the newest live
      // sample, and an existing timestamp is never overwritten.
      const cutoff = newest ? newest.t : Number.POSITIVE_INFINITY;
      const existingTs = new Set(buf.samples.map((s) => s.t));
      const inserts = clean.filter((s) => s.t < cutoff && !existingTs.has(s.t));
      if (inserts.length === 0) return;
      buf.samples.push(...inserts);
      buf.samples.sort((a, b) => a.t - b.t);
      evict(buf.samples, buf.samples[buf.samples.length - 1]!.t);
      buf.snapshot = null;
    },

    markGap(tokenId, atMs) {
      const buf = buffers.get(tokenId);
      if (!buf || buf.samples.length === 0) return;
      buf.samples = buf.samples.filter((s) => s.t > atMs);
      buf.snapshot = null;
    },

    history(tokenId) {
      const buf = buffers.get(tokenId);
      if (!buf || buf.samples.length === 0) return undefined;
      buf.snapshot ??= [...buf.samples];
      return buf.snapshot;
    },

    drop(tokenId) {
      buffers.delete(tokenId);
    },

    clear() {
      buffers.clear();
    },

    size() {
      return buffers.size;
    },
  };
};
