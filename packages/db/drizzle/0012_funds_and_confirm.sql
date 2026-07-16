-- Track A: owner-only withdrawals (idempotency + history). Track B: confirm-mode
-- proposed batches + fill/PnL accounting on quote_sessions. All additive.
-- ROLLBACK:
--   DROP TABLE "wallet_withdrawals";
--   ALTER TABLE "quote_sessions"
--     DROP COLUMN "pending_batch", DROP COLUMN "pending_batch_hash",
--     DROP COLUMN "pending_batch_at", DROP COLUMN "approved_batch_hash",
--     DROP COLUMN "approved_at", DROP COLUMN "inventory_yes_cost_usd",
--     DROP COLUMN "inventory_no_cost_usd", DROP COLUMN "daily_loss_day";
CREATE TABLE IF NOT EXISTS "wallet_withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "deposit_wallet_address" text NOT NULL,
  "destination_address" text NOT NULL,
  "amount_usd" numeric NOT NULL,
  "state" text NOT NULL DEFAULT 'requested',
  "relayer_transaction_id" text,
  "transaction_hash" text,
  "error" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_withdrawals_idem_unique"
  ON "wallet_withdrawals" ("wallet_address", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_withdrawals_wallet_idx" ON "wallet_withdrawals" ("wallet_address");
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "pending_batch" jsonb;
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "pending_batch_hash" text;
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "pending_batch_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "approved_batch_hash" text;
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "inventory_yes_cost_usd" numeric NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "inventory_no_cost_usd" numeric NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "quote_sessions" ADD COLUMN IF NOT EXISTS "daily_loss_day" text;
