-- Server-synced builder drafts (hybrid persistence, ADR-0019): free-form
-- StrategyDoc JSON + per-draft AI chat, keyed by the client's draft id so
-- localStorage and the account stay one logical store. Deliberately separate
-- from conditional_rules: drafts mutate on every keystroke and may not
-- compile, while armed definitions are immutable (D-020) and worker-visible.
-- ROLLBACK: DROP TABLE "strategy_drafts";
CREATE TABLE IF NOT EXISTS "strategy_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "client_draft_id" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "origin" text NOT NULL DEFAULT 'blank',
  "doc" jsonb NOT NULL,
  "ai_messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ai_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "schema_version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "armed_rule_id" uuid,
  "updated_at_client" bigint NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_drafts_wallet_client_unique"
  ON "strategy_drafts" ("wallet_address", "client_draft_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_drafts_wallet_idx" ON "strategy_drafts" ("wallet_address");
