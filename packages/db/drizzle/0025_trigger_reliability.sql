-- Trigger reliability (docs/TRIGGER_RELIABILITY_AUDIT.md, Slice 2):
-- 1) DB-level idempotency for signing proposals: at most ONE rule_triggers row
--    per (rule_id, evidence triggerNumber). The previous guard was
--    application-level only (and covered once-recurrence only), so overlapping
--    evaluations could write duplicate signing prompts. Pre-existing
--    duplicates keep the EARLIEST row (the one users saw and acted on).
-- 2) market_snapshots.market_status: real upstream status (resolved/closed/
--    paused) so the UI can say "market resolved" instead of "no fresh data".
--    NULL = unknown/open (all existing rows).
-- ROLLBACK:
--   DROP INDEX IF EXISTS "rule_triggers_rule_trigger_number_uidx";
--   ALTER TABLE "market_snapshots" DROP COLUMN IF EXISTS "market_status";
DELETE FROM "rule_triggers" a
  USING "rule_triggers" b
  WHERE a.rule_id = b.rule_id
    AND (a.evidence->>'triggerNumber') IS NOT NULL
    AND (a.evidence->>'triggerNumber') = (b.evidence->>'triggerNumber')
    AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_triggers_rule_trigger_number_uidx"
  ON "rule_triggers" ("rule_id", (((evidence->>'triggerNumber'))::int))
  WHERE evidence ? 'triggerNumber';
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN IF NOT EXISTS "market_status" text;
