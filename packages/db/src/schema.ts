import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * Append-only audit log. Rows are immutable: the application never issues
 * UPDATE or DELETE against this table. Retention/archival is handled out of
 * band (see docs/07 operations). See packages/core AuditAction for the
 * controlled action vocabulary.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subject: text("subject"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_actor_idx").on(t.actor),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_created_at_idx").on(t.createdAt),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

/**
 * Live orderbook snapshots written by the WebSocket worker. Mutable (UPSERT on
 * token_id). isStale=true when the WS channel has gone quiet beyond the
 * staleness threshold; the API surfaces this to prevent misleading UI state.
 */
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    tokenId: text("token_id").primaryKey(),
    conditionId: text("condition_id").notNull(),
    bids: jsonb("bids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    asks: jsonb("asks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastTradePrice: text("last_trade_price"),
    midPrice: text("mid_price"),
    source: text("source").notNull().default("rest"),
    isStale: boolean("is_stale").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("market_snapshots_condition_id_idx").on(t.conditionId),
    index("market_snapshots_updated_at_idx").on(t.updatedAt),
  ],
);

export type MarketSnapshotRow = typeof marketSnapshots.$inferSelect;
export type NewMarketSnapshotRow = typeof marketSnapshots.$inferInsert;
