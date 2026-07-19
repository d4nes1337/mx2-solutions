-- Strategy activity timeline reads audit events by subject ("rule:<id>",
-- "intent:<id>") newest-first; without this index that is a full scan of an
-- append-only table. Additive.
-- ROLLBACK: DROP INDEX "audit_events_subject_created_idx";
-- Plain ASC composite (matches the drizzle schema declaration): the newest-
-- first timeline query is served by a backward index scan.
CREATE INDEX IF NOT EXISTS "audit_events_subject_created_idx"
  ON "audit_events" ("subject", "created_at");
