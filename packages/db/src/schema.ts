import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

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
