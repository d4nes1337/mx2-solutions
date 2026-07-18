-- Order fill reconciliation (additive). The worker's order-sync loop advances
-- order_intents past "submitted" by polling the CLOB (open orders + trades):
--   filled_size      cumulative matched size (numeric string, share units)
--   avg_fill_price   size-weighted average fill price once known
--   last_synced_at   last reconciliation pass that saw this intent
-- ROLLBACK:
--   ALTER TABLE "order_intents" DROP COLUMN "filled_size",
--     DROP COLUMN "avg_fill_price", DROP COLUMN "last_synced_at";
ALTER TABLE "order_intents" ADD COLUMN IF NOT EXISTS "filled_size" numeric NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN IF NOT EXISTS "avg_fill_price" numeric;
--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;
