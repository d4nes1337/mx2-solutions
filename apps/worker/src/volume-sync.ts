import type { Logger } from "@mx2/observability";
import type { VolumeStore } from "@mx2/db";
import { deriveDepositWallet, type Activity, type DataClient } from "@mx2/polymarket-client";

/**
 * Hourly per-user traded-volume rollup (FEATURE_REFERRALS). For every active
 * allowlisted wallet: derive the Polymarket deposit (proxy) wallet, pull Data
 * API /activity TRADE rows newer than the stored cursor, and fold them into
 * user_volume_daily + user_volume_stats. Read-only upstream; display-grade
 * stats (leaderboard, admin panel) — never accounting.
 *
 * Fail-soft per wallet: one user's upstream error skips them until the next
 * pass and never aborts the sweep. Requests are staggered to stay far from
 * Data API rate limits at beta scale.
 */
export interface VolumeSyncOptions {
  logger: Logger;
  volumeStore: VolumeStore;
  dataClient: DataClient;
  intervalMs?: number;
  /** Pause between users within one sweep. */
  staggerMs?: number;
  /** /activity page size (Data API max is 500). */
  pageLimit?: number;
  /** Safety valve on pages per user per pass (first backfill can be long). */
  maxPagesPerUser?: number;
}

export interface VolumeSyncLoop {
  start(): void;
  /** One full sweep (exposed for tests and the manual backfill script). */
  runOnce(): Promise<void>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_STAGGER_MS = 750;
const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_MAX_PAGES = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** TRADE rows strictly newer than the cursor, oldest-boundary safe. */
export const newTradesFrom = (
  activities: readonly Activity[],
  lastSyncedTimestamp: number,
): { timestamp: number; usdcSize: number }[] =>
  activities
    .filter((a) => a.type === "TRADE" && a.timestamp > lastSyncedTimestamp)
    .map((a) => ({ timestamp: a.timestamp, usdcSize: a.usdcSize }));

export const createVolumeSyncLoop = (opts: VolumeSyncOptions): VolumeSyncLoop => {
  const {
    logger,
    volumeStore,
    dataClient,
    intervalMs = DEFAULT_INTERVAL_MS,
    staggerMs = DEFAULT_STAGGER_MS,
    pageLimit = DEFAULT_PAGE_LIMIT,
    maxPagesPerUser = DEFAULT_MAX_PAGES,
  } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const syncWallet = async (
    walletAddress: string,
    lastSyncedTimestamp: number,
  ): Promise<number> => {
    const proxyWallet = deriveDepositWallet(walletAddress);

    // Newest-first pages; stop as soon as a page dips at/under the cursor.
    const collected: { timestamp: number; usdcSize: number }[] = [];
    for (let page = 0; page < maxPagesPerUser; page++) {
      const res = await dataClient.getActivity({
        user: proxyWallet,
        type: "TRADE",
        limit: pageLimit,
        offset: page * pageLimit,
      });
      if (!res.ok) throw new Error(`activity fetch failed: ${res.error.message}`);
      const fresh = newTradesFrom(res.value, lastSyncedTimestamp);
      collected.push(...fresh);
      // Page exhausted (short page) or we crossed the cursor boundary.
      if (res.value.length < pageLimit || fresh.length < res.value.length) break;
    }

    if (collected.length === 0) {
      await volumeStore.touchSynced(walletAddress, proxyWallet);
      return 0;
    }
    await volumeStore.applyTrades({ walletAddress, proxyWallet, trades: collected });
    return collected.length;
  };

  const runOnce = async (): Promise<void> => {
    if (running) return; // A slow sweep must not stack on itself.
    running = true;
    try {
      const targets = await volumeStore.listSyncTargets();
      let synced = 0;
      let tradesSeen = 0;
      for (const target of targets) {
        try {
          tradesSeen += await syncWallet(target.walletAddress, target.lastSyncedTimestamp);
          synced++;
        } catch (error) {
          logger.warn(
            { event: "volume_sync.wallet_failed", wallet: target.walletAddress, err: error },
            "volume sync: wallet skipped",
          );
        }
        if (staggerMs > 0) await sleep(staggerMs);
      }
      logger.info(
        { event: "volume_sync.pass", wallets: targets.length, synced, tradesSeen },
        "volume sync pass complete",
      );
    } finally {
      running = false;
    }
  };

  return {
    start() {
      // First sweep shortly after boot, then hourly.
      setTimeout(() => {
        runOnce().catch((e: unknown) => logger.warn({ err: e }, "Volume-sync pass failed"));
      }, 15_000);
      timer = setInterval(() => {
        runOnce().catch((e: unknown) => logger.warn({ err: e }, "Volume-sync pass failed"));
      }, intervalMs);
    },
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
