-- Full-cycle reliability (owner beta findings, 2026-07):
--   conditional_rules: stale-pause runtime marker + versioned-edit linkage
--   rule_triggers:     bounded auto-retry when a recoverable guard skipped
--   bridge_deposits:   lifecycle terminals (superseded/expired), user dismiss,
--                      completion provenance; backfill orphaned zero-timestamp
--                      rows that have a timestamped sibling (dedupe-key bug).
-- All additive.
-- ROLLBACK:
--   ALTER TABLE "conditional_rules" DROP COLUMN "stale_since", DROP COLUMN "supersedes", DROP COLUMN "superseded_by";
--   ALTER TABLE "rule_triggers" DROP COLUMN "auto_retry_until", DROP COLUMN "auto_retry_reason";
--   DROP INDEX "rule_triggers_retry_idx";
--   ALTER TABLE "bridge_deposits" DROP COLUMN "superseded_by_deposit_id", DROP COLUMN "dismissed_at", DROP COLUMN "completion_source";
--   (backfilled rows: UPDATE bridge_deposits SET state='detected', superseded_by_deposit_id=NULL WHERE state='superseded' AND provider_created_time_ms=0;)
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "stale_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "supersedes" uuid;
--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;
--> statement-breakpoint
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "auto_retry_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "rule_triggers" ADD COLUMN IF NOT EXISTS "auto_retry_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_triggers_retry_idx"
  ON "rule_triggers" ("status", "auto_retry_until") WHERE "auto_retry_until" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bridge_deposits" ADD COLUMN IF NOT EXISTS "superseded_by_deposit_id" uuid;
--> statement-breakpoint
ALTER TABLE "bridge_deposits" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "bridge_deposits" ADD COLUMN IF NOT EXISTS "completion_source" text;
--> statement-breakpoint
-- Backfill: a non-terminal row keyed with provider_created_time_ms=0 whose
-- (address, chain, token, amount) group also contains a timestamped row is the
-- orphaned first-poll insert of the SAME transfer (the provider added
-- createdTimeMs on a later poll, changing the dedupe key). Point it at the
-- newest timestamped sibling and retire it.
UPDATE "bridge_deposits" AS d
SET "state" = 'superseded',
    "superseded_by_deposit_id" = s.id,
    "updated_at" = now()
FROM (
  SELECT DISTINCT ON ("bridge_address_id", "from_chain_id", "from_token_address", "from_amount_base_unit")
         "id", "bridge_address_id", "from_chain_id", "from_token_address", "from_amount_base_unit"
  FROM "bridge_deposits"
  WHERE "provider_created_time_ms" <> 0
  ORDER BY "bridge_address_id", "from_chain_id", "from_token_address", "from_amount_base_unit",
           "provider_created_time_ms" DESC
) AS s
WHERE d."provider_created_time_ms" = 0
  AND d."state" IN ('detected', 'processing', 'origin_confirmed', 'submitted')
  AND d."bridge_address_id" = s."bridge_address_id"
  AND d."from_chain_id" = s."from_chain_id"
  AND d."from_token_address" = s."from_token_address"
  AND d."from_amount_base_unit" = s."from_amount_base_unit";
