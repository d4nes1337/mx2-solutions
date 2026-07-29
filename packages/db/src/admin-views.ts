import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { allowlist, referralCodes, referralRedemptions, users, userVolumeStats } from "./schema.js";

/**
 * Read-only joins for the /admin panel. Kept out of the per-table stores so
 * the write paths stay narrow; everything here is display-shaped and cheap at
 * beta scale (hundreds of rows).
 */

export interface AdminUserRow {
  walletAddress: string;
  createdAt: Date;
  lastSeenAt: Date;
  allowlisted: boolean;
  allowlistAddedBy: string | null;
  referredByCode: string | null;
  referrerWallet: string | null;
  referredAt: Date | null;
  /** Numeric column comes back as text from pg; null when never synced. */
  lifetimeVolumeUsd: string | null;
  tradeCount: number | null;
  lastTradeAt: Date | null;
}

export interface AdminCodeStats {
  codeId: string;
  refereeCount: number;
  attributedVolumeUsd: string;
}

export interface AdminOverview {
  totalUsers: number;
  allowlistedActive: number;
  totalCodes: number;
  seatsUsed: number;
  seatsTotal: number;
  /** Referral signups per UTC day, ascending, last 30 days. */
  redemptionsByDay: { day: string; count: number }[];
}

export interface AdminViewsStore {
  listUsers(): Promise<AdminUserRow[]>;
  codeStats(): Promise<AdminCodeStats[]>;
  overview(): Promise<AdminOverview>;
}

export const createAdminViewsStore = (db: Database): AdminViewsStore => ({
  async listUsers() {
    const rows = await db
      .select({
        walletAddress: users.walletAddress,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        allowlisted: allowlist.isActive,
        allowlistAddedBy: allowlist.addedBy,
        referredByCode: referralCodes.code,
        referrerWallet: referralRedemptions.referrerWallet,
        referredAt: referralRedemptions.redeemedAt,
        lifetimeVolumeUsd: userVolumeStats.lifetimeVolumeUsd,
        tradeCount: userVolumeStats.tradeCount,
        lastTradeAt: userVolumeStats.lastTradeAt,
      })
      .from(users)
      .leftJoin(allowlist, eq(allowlist.walletAddress, users.walletAddress))
      .leftJoin(referralRedemptions, eq(referralRedemptions.walletAddress, users.walletAddress))
      .leftJoin(referralCodes, eq(referralCodes.id, referralRedemptions.codeId))
      .leftJoin(userVolumeStats, eq(userVolumeStats.walletAddress, users.walletAddress))
      .orderBy(desc(users.createdAt));
    return rows.map((r) => ({
      ...r,
      allowlisted: r.allowlisted === true,
    }));
  },

  async codeStats() {
    const rows = await db
      .select({
        codeId: referralRedemptions.codeId,
        refereeCount: sql<number>`count(*)::int`,
        attributedVolumeUsd: sql<string>`coalesce(sum(${userVolumeStats.lifetimeVolumeUsd}), 0)::text`,
      })
      .from(referralRedemptions)
      .leftJoin(
        userVolumeStats,
        eq(userVolumeStats.walletAddress, referralRedemptions.walletAddress),
      )
      .groupBy(referralRedemptions.codeId);
    return rows;
  },

  async overview() {
    const [userCounts] = await db
      .select({
        totalUsers: sql<number>`count(*)::int`,
      })
      .from(users);
    const [allowCounts] = await db
      .select({
        allowlistedActive: sql<number>`count(*) filter (where ${allowlist.isActive})::int`,
      })
      .from(allowlist);
    const [codeCounts] = await db
      .select({
        totalCodes: sql<number>`count(*)::int`,
        seatsUsed: sql<number>`coalesce(sum(${referralCodes.usedCount}), 0)::int`,
        seatsTotal: sql<number>`coalesce(sum(${referralCodes.maxUses}), 0)::int`,
      })
      .from(referralCodes);
    const redemptionsByDay = await db
      .select({
        day: sql<string>`to_char(${referralRedemptions.redeemedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(referralRedemptions)
      .where(sql`${referralRedemptions.redeemedAt} > now() - interval '30 days'`)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return {
      totalUsers: userCounts?.totalUsers ?? 0,
      allowlistedActive: allowCounts?.allowlistedActive ?? 0,
      totalCodes: codeCounts?.totalCodes ?? 0,
      seatsUsed: codeCounts?.seatsUsed ?? 0,
      seatsTotal: codeCounts?.seatsTotal ?? 0,
      redemptionsByDay,
    };
  },
});
