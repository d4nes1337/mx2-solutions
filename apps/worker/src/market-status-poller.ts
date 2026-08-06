import type { Logger } from "@mx2/observability";
import type { MarketSnapshotStore } from "@mx2/db";
import type { GammaClient } from "@mx2/polymarket-client";
import type { MarketStatus } from "@mx2/rules";

/**
 * Real market-status polling (Gamma). The WS feed never says "this market
 * closed/resolved" — it just goes quiet, which is indistinguishable from a
 * dead feed. Before this poller, a resolved 5-minute instant market left its
 * strategies stuck in DATA_STALE churn forever and the UI said "no fresh
 * data" about a market that no longer exists.
 *
 * Every pass: for each watched condition id, read Gamma's closed/active
 * flags, map to a MarketStatus (`closed → "resolved"` — conservative: both
 * invalidate a rule; `active:false → "paused"`), push it into the evaluator
 * (reaching the previously-unreachable INVALIDATED path) and stamp
 * market_snapshots.market_status for the UI.
 */
export interface MarketStatusPoller {
  start(): void;
  stop(): void;
}

export interface MarketStatusPollerOptions {
  logger: Logger;
  gammaClient: Pick<GammaClient, "findMarket">;
  marketSnapshots: Pick<MarketSnapshotStore, "setMarketStatus">;
  /** Watched tokens with their condition ids (evaluator.watched). */
  listWatched: () => ReadonlyArray<{ tokenId: string; conditionId: string }>;
  onMarketStatus: (tokenId: string, status: MarketStatus) => void;
  /** Poll cadence. Default 60 s. */
  intervalMs?: number;
  /** Max condition ids checked per pass (Gamma load bound). Default 24. */
  maxPerPass?: number;
}

export const createMarketStatusPoller = (opts: MarketStatusPollerOptions): MarketStatusPoller => {
  const { logger, gammaClient, marketSnapshots, listWatched, onMarketStatus } = opts;
  const intervalMs = opts.intervalMs ?? 60_000;
  const maxPerPass = opts.maxPerPass ?? 24;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;
  let inFlight = false;
  /** Last stamped status per token — avoid rewriting an unchanged column. */
  const lastStamped = new Map<string, string | null>();

  const pass = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const watched = listWatched();
      if (watched.length === 0) return;
      // Distinct condition ids, round-robin under the per-pass cap.
      const byCondition = new Map<string, string[]>();
      for (const w of watched) {
        byCondition.set(w.conditionId, [...(byCondition.get(w.conditionId) ?? []), w.tokenId]);
      }
      const conditions = [...byCondition.keys()];
      const start = cursor % conditions.length;
      const batch = [...conditions.slice(start), ...conditions.slice(0, start)].slice(
        0,
        maxPerPass,
      );
      cursor += batch.length;

      for (const conditionId of batch) {
        const result = await gammaClient.findMarket({ conditionId });
        if (!result.ok || result.value === null) continue; // fail open: unknown ≠ closed
        const market = result.value;
        const status: MarketStatus = market.closed
          ? "resolved"
          : market.active === false
            ? "paused"
            : "open";
        for (const tokenId of byCondition.get(conditionId) ?? []) {
          onMarketStatus(tokenId, status);
          const stamp = status === "open" ? null : status;
          // Never-stamped (undefined) and open (null) are the same state.
          if ((lastStamped.get(tokenId) ?? null) !== stamp) {
            lastStamped.set(tokenId, stamp);
            marketSnapshots.setMarketStatus(tokenId, stamp).catch((e: unknown) => {
              logger.warn({ err: e, tokenId }, "Failed to stamp market status");
            });
            if (stamp !== null) {
              logger.info({ tokenId, conditionId, status }, "Market status changed upstream");
            }
          }
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "Market status pass failed");
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      timer = setInterval(() => {
        void pass();
      }, intervalMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
};
