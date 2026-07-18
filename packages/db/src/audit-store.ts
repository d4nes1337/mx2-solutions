import { and, desc, eq, lt } from "drizzle-orm";
import type { AuditEvent, NewAuditEvent } from "@mx2/core";
import type { Database } from "./client.js";
import { auditEvents, type AuditEventRow } from "./schema.js";

const toDomain = (row: AuditEventRow): AuditEvent => ({
  id: row.id,
  actor: row.actor,
  action: row.action as AuditEvent["action"],
  subject: row.subject,
  metadata: row.metadata as Record<string, unknown>,
  createdAt: row.createdAt,
});

/**
 * Append-only access to the audit log. There is intentionally no update or
 * delete method — audit events are immutable.
 */
export interface AuditStore {
  emit(event: NewAuditEvent): Promise<AuditEvent>;
  recent(limit?: number): Promise<AuditEvent[]>;
  forActor(actor: string, limit?: number): Promise<AuditEvent[]>;
  /** Events for one subject (e.g. "rule:<id>"), newest first; `before` pages. */
  forSubject(subject: string, limit?: number, before?: Date): Promise<AuditEvent[]>;
}

export const createAuditStore = (db: Database): AuditStore => ({
  async emit(event) {
    const [row] = await db
      .insert(auditEvents)
      .values({
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        metadata: event.metadata,
      })
      .returning();
    if (!row) throw new Error("Failed to insert audit event");
    return toDomain(row);
  },

  async recent(limit = 100) {
    const rows = await db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map(toDomain);
  },

  async forActor(actor, limit = 100) {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actor, actor))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map(toDomain);
  },

  async forSubject(subject, limit = 100, before) {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        before !== undefined
          ? and(eq(auditEvents.subject, subject), lt(auditEvents.createdAt, before))
          : eq(auditEvents.subject, subject),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map(toDomain);
  },
});
