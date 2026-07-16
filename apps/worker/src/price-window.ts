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
 * Reconnect semantics: `clear()` wipes every buffer — windows must refill
 * before any price_move condition can hold again (fail-closed, mirrors
 * RECONNECT_RESET for accumulating windows).
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
  /** Oldest-first samples for the token (cached between mutations). */
  history(tokenId: string): readonly PriceSample[] | undefined;
  /** Drop one token's buffer (unsubscribed). */
  drop(tokenId: string): void;
  /** Wipe everything (WS reconnect — continuity is broken). */
  clear(): void;
  /** Number of tracked tokens (observability/tests). */
  size(): number;
}

export const createPriceWindowStore = (): PriceWindowStore => {
  const buffers = new Map<string, TokenBuffer>();

  return {
    push(tokenId, price, tMs) {
      if (!Number.isFinite(price) || price <= 0 || price >= 1) return;
      let buf = buffers.get(tokenId);
      if (!buf) {
        buf = { samples: [], snapshot: null };
        buffers.set(tokenId, buf);
      }
      // Out-of-order guard: ignore samples older than the newest one (WS
      // batches arrive in order; anything else is clock noise).
      const newest = buf.samples[buf.samples.length - 1];
      if (newest && tMs < newest.t) return;
      buf.samples.push({ t: tMs, p: price });

      // Evict beyond the horizon, keeping ONE sample at/before it (carry-in).
      const cutoff = tMs - HORIZON_MS;
      let firstInside = 0;
      while (firstInside < buf.samples.length && buf.samples[firstInside]!.t <= cutoff) {
        firstInside++;
      }
      const keepFrom = Math.max(0, firstInside - 1);
      if (keepFrom > 0) buf.samples.splice(0, keepFrom);
      if (buf.samples.length > MAX_SAMPLES) {
        buf.samples.splice(0, buf.samples.length - MAX_SAMPLES);
      }
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
