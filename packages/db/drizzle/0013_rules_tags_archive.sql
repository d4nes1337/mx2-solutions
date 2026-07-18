-- Smart Orders organization: freeform tags + reversible archive. Archive is a
-- soft-hide for TERMINAL statuses only (enforced in the store) — an active
-- strategy can never disappear from monitoring, and nothing is hard-deleted.
-- All additive.
-- ROLLBACK:
--   DROP INDEX "conditional_rules_wallet_live_idx";
--   ALTER TABLE "conditional_rules" DROP COLUMN "tags", DROP COLUMN "archived_at";
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conditional_rules_wallet_live_idx"
  ON "conditional_rules" ("wallet_address") WHERE "archived_at" IS NULL;
