import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  allowlist,
  referralCodes,
  referralRedemptions,
  userVolumeDaily,
  userVolumeStats,
  type UserVolumeStatsRow,
} from "./schema.js";

/**
 * Per-user traded-volume rollups, fed by the worker's volume-sync loop from
 * Data API /activity TRADE rows. Stats are display-grade (leaderboard, admin
 * columns), not accounting: the incremental cursor is the newest counted
 * activity timestamp, and a trade landing later with exactly that timestamp
 * is skipped rather than risking double counting (fail-under, never over).
 */

export interface VolumeTrade {
  /** Data API activity timestamp (unix seconds). */
  timestamp: number;
  usdcSize: number;
}

export interface VolumeSyncTarget {
  walletAddress: string;
  lastSyncedTimestamp: number;
}

export interface LeaderboardRow {
  code: string;
  ownerWallet: string | null;
  refereeCount: number;
  attributedVolumeUsd: string;
}

export interface VolumeStore {
  /** Active allowlisted wallets with their sync cursor (0 = never synced). */
  listSyncTargets(): Promise<VolumeSyncTarget[]>;
  /** Applies newly seen trades: daily buckets + lifetime stats, one tx. */
  applyTrades(opts: {
    walletAddress: string;
    proxyWallet: string;
    trades: VolumeTrade[];
  }): Promise<void>;
  /** Marks a no-new-trades pass so syncedAt stays honest. */
  touchSynced(walletAddress: string, proxyWallet: string): Promise<void>;
  statsFor(walletAddress: string): Promise<UserVolumeStatsRow | null>;
  /** Public leaderboard: codes with ≥1 referee, by attributed lifetime volume. */
  referralLeaderboard(limit: number): Promise<LeaderboardRow[]>;
  /** Attributed lifetime volume for specific codes (profile "your impact"). */
  attributedForCodes(codeIds: string[]): Promise<{ codeId: string; attributedVolumeUsd: string }[]>;
}

const dayOf = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10);
};

export const createVolumeStore = (db: Database): VolumeStore => ({
  async listSyncTargets() {
    const rows = await db
      .select({
        walletAddress: allowlist.walletAddress,
        lastSyncedTimestamp: userVolumeStats.lastSyncedTimestamp,
      })
      .from(allowlist)
      .leftJoin(userVolumeStats, eq(userVolumeStats.walletAddress, allowlist.walletAddress))
      .where(eq(allowlist.isActive, true));
    return rows.map((r) => ({
      walletAddress: r.walletAddress,
      lastSyncedTimestamp: r.lastSyncedTimestamp ?? 0,
    }));
  },

  async applyTrades({ walletAddress, proxyWallet, trades }) {
    if (trades.length === 0) return;
    const wallet = walletAddress.toLowerCase();

    const byDay = new Map<string, { volume: number; count: number }>();
    let total = 0;
    let maxTs = 0;
    for (const t of trades) {
      if (!Number.isFinite(t.usdcSize) || t.usdcSize <= 0) continue;
      const day = dayOf(t.timestamp);
      const bucket = byDay.get(day) ?? { volume: 0, count: 0 };
      bucket.volume += t.usdcSize;
      bucket.count += 1;
      byDay.set(day, bucket);
      total += t.usdcSize;
      if (t.timestamp > maxTs) maxTs = t.timestamp;
    }
    if (byDay.size === 0) return;
    const tradeCount = [...byDay.values()].reduce((n, b) => n + b.count, 0);

    await db.transaction(async (tx) => {
      for (const [day, bucket] of byDay) {
        await tx
          .insert(userVolumeDaily)
          .values({
            walletAddress: wallet,
            day,
            volumeUsd: bucket.volume.toFixed(6),
            tradeCount: bucket.count,
          })
          .onConflictDoUpdate({
            target: [userVolumeDaily.walletAddress, userVolumeDaily.day],
            set: {
              volumeUsd: sql`${userVolumeDaily.volumeUsd} + ${bucket.volume.toFixed(6)}`,
              tradeCount: sql`${userVolumeDaily.tradeCount} + ${bucket.count}`,
            },
          });
      }
      await tx
        .insert(userVolumeStats)
        .values({
          walletAddress: wallet,
          proxyWallet,
          lifetimeVolumeUsd: total.toFixed(6),
          tradeCount,
          lastTradeAt: new Date(maxTs * 1000),
          lastSyncedTimestamp: maxTs,
          syncedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: userVolumeStats.walletAddress,
          set: {
            proxyWallet,
            lifetimeVolumeUsd: sql`${userVolumeStats.lifetimeVolumeUsd} + ${total.toFixed(6)}`,
            tradeCount: sql`${userVolumeStats.tradeCount} + ${tradeCount}`,
            lastTradeAt: sql`greatest(coalesce(${userVolumeStats.lastTradeAt}, 'epoch'::timestamptz), ${new Date(maxTs * 1000).toISOString()}::timestamptz)`,
            lastSyncedTimestamp: sql`greatest(${userVolumeStats.lastSyncedTimestamp}, ${maxTs})`,
            syncedAt: sql`now()`,
          },
        });
    });
  },

  async touchSynced(walletAddress, proxyWallet) {
    await db
      .insert(userVolumeStats)
      .values({ walletAddress: walletAddress.toLowerCase(), proxyWallet, syncedAt: sql`now()` })
      .onConflictDoUpdate({
        target: userVolumeStats.walletAddress,
        set: { proxyWallet, syncedAt: sql`now()` },
      });
  },

  async statsFor(walletAddress) {
    const [row] = await db
      .select()
      .from(userVolumeStats)
      .where(eq(userVolumeStats.walletAddress, walletAddress.toLowerCase()))
      .limit(1);
    return row ?? null;
  },

  async attributedForCodes(codeIds) {
    if (codeIds.length === 0) return [];
    return db
      .select({
        codeId: referralRedemptions.codeId,
        attributedVolumeUsd: sql<string>`coalesce(sum(${userVolumeStats.lifetimeVolumeUsd}), 0)::text`,
      })
      .from(referralRedemptions)
      .leftJoin(
        userVolumeStats,
        eq(userVolumeStats.walletAddress, referralRedemptions.walletAddress),
      )
      .where(inArray(referralRedemptions.codeId, codeIds))
      .groupBy(referralRedemptions.codeId);
  },

  async referralLeaderboard(limit) {
    const volume = sql<string>`coalesce(sum(${userVolumeStats.lifetimeVolumeUsd}), 0)`;
    const rows = await db
      .select({
        code: referralCodes.code,
        ownerWallet: referralCodes.ownerWallet,
        refereeCount: sql<number>`count(${referralRedemptions.id})::int`,
        attributedVolumeUsd: sql<string>`${volume}::text`,
      })
      .from(referralCodes)
      .innerJoin(referralRedemptions, eq(referralRedemptions.codeId, referralCodes.id))
      .leftJoin(
        userVolumeStats,
        eq(userVolumeStats.walletAddress, referralRedemptions.walletAddress),
      )
      .groupBy(referralCodes.id)
      .orderBy(desc(volume))
      .limit(limit);
    return rows;
  },
});
