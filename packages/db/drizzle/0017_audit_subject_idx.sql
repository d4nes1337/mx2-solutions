-- Strategy activity timeline reads audit events by subject ("rule:<id>",
-- "intent:<id>") newest-first; without this index that is a full scan of an
-- append-only table. Additive.
-- ROLLBACK: DROP INDEX "audit_events_subject_created_idx";
CREATE INDEX IF NOT EXISTS "audit_events_subject_created_idx"
  ON "audit_events" ("subject", "created_at" DESC);
