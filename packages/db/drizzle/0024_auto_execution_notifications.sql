-- W5: auto-executed orders get full in-app notification parity.
-- rule_triggers gains:
--   auto_executed_at    — worker submitted this trigger's order unattended
--   auto_failed_at      — an auto attempt terminally failed / degraded to manual
--   auto_failure_reason — skip/failure reason code (UI banner + audit context)
--   acknowledged_at     — user dismissed the auto-executed card from the bell
-- Additive only; NULL on all existing rows (manual/legacy triggers).
-- ROLLBACK:
--   DROP INDEX IF EXISTS "rule_triggers_auto_unacked_idx";
--   ALTER TABLE "rule_triggers" DROP COLUMN IF EXISTS "acknowledged_at";
--   ALTER TABLE "rule_triggers" DROP COLUMN IF EXISTS "auto_failure_reason";
--   ALTER TABLE "rule_triggers" DROP COLUMN IF EXISTS "auto_failed_at";
--   ALTER TABLE "rule_triggers" DROP COLUMN IF EXISTS "auto_executed_at";
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "auto_executed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "auto_failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "auto_failure_reason" text;
--> statement-breakpoint
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_triggers_auto_unacked_idx"
  ON "rule_triggers" ("wallet_address")
  WHERE "auto_executed_at" IS NOT NULL AND "acknowledged_at" IS NULL;
