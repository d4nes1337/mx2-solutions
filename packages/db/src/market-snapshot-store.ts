import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { marketSnapshots, type MarketSnapshotRow } from "./schema.js";

export interface UpsertMarketSnapshot {
  tokenId: string;
  conditionId: string;
  bids: readonly unknown[];
  asks: readonly unknown[];
  lastTradePrice: string | null;
  midPrice: string | null;
  source: string;
  isStale: boolean;
  receivedAt: Date;
}

export interface MarketSnapshotStore {
  upsert(snapshot: UpsertMarketSnapshot): Promise<MarketSnapshotRow>;
  findByTokenId(tokenId: string): Promise<MarketSnapshotRow | null>;
  markStale(tokenId: string): Promise<void>;
}

export const createMarketSnapshotStore = (db: Database): MarketSnapshotStore => ({
  async upsert(snapshot) {
    const now = new Date();
    const [row] = await db
      .insert(marketSnapshots)
      .values({
        tokenId: snapshot.tokenId,
        conditionId: snapshot.conditionId,
        bids: snapshot.bids,
        asks: snapshot.asks,
        lastTradePrice: snapshot.lastTradePrice,
        midPrice: snapshot.midPrice,
        source: snapshot.source,
        isStale: snapshot.isStale,
        receivedAt: snapshot.receivedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: marketSnapshots.tokenId,
        set: {
          conditionId: snapshot.conditionId,
          bids: snapshot.bids,
          asks: snapshot.asks,
          lastTradePrice: snapshot.lastTradePrice,
          midPrice: snapshot.midPrice,
          source: snapshot.source,
          isStale: snapshot.isStale,
          receivedAt: snapshot.receivedAt,
          updatedAt: now,
        },
      })
      .returning();
    if (row === undefined) throw new Error("market snapshot upsert returned no row");
    return row;
  },

  async findByTokenId(tokenId) {
    const [row] = await db
      .select()
      .from(marketSnapshots)
      .where(eq(marketSnapshots.tokenId, tokenId))
      .limit(1);
    return row ?? null;
  },

  async markStale(tokenId) {
    await db
      .update(marketSnapshots)
      .set({ isStale: true, updatedAt: sql`now()` })
      .where(eq(marketSnapshots.tokenId, tokenId));
  },
});
