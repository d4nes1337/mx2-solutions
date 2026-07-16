-- Maker-loop quoting sessions (RFC-0003, ADR-0014). quote_events is
-- append-only (no UPDATE/DELETE issued by the application); the UNIQUE
-- idempotency key is the DB-level anti-replay guard for quoter actions.
-- Rollback: DROP TABLE reward_accruals; DROP TABLE quote_events;
--           DROP TABLE quote_sessions;

CREATE TABLE IF NOT EXISTS "quote_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id" uuid NOT NULL,
  "wallet_address" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'shadow',
  "status" text NOT NULL DEFAULT 'idle',
  "halted_reason" text,
  "inventory_yes" numeric NOT NULL DEFAULT '0',
  "inventory_no" numeric NOT NULL DEFAULT '0',
  "capital_committed_usd" numeric NOT NULL DEFAULT '0',
  "realized_pnl_usd" numeric NOT NULL DEFAULT '0',
  "daily_loss_usd" numeric NOT NULL DEFAULT '0',
  "rewards_accrued_usd" numeric NOT NULL DEFAULT '0',
  "last_cycle_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_sessions_rule_idx" ON "quote_sessions" ("rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_sessions_wallet_idx" ON "quote_sessions" ("wallet_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_sessions_status_idx" ON "quote_sessions" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "rule_id" uuid NOT NULL,
  "type" text NOT NULL,
  "idempotency_key" text UNIQUE,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_events_session_idx" ON "quote_events" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_events_rule_idx" ON "quote_events" ("rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_events_created_at_idx" ON "quote_events" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reward_accruals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "condition_id" text NOT NULL,
  "day" text NOT NULL,
  "rewards_usd" numeric NOT NULL DEFAULT '0',
  "raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reward_accruals_wallet_market_day_unique" ON "reward_accruals" ("wallet_address", "condition_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reward_accruals_wallet_idx" ON "reward_accruals" ("wallet_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reward_accruals_market_idx" ON "reward_accruals" ("condition_id");
