-- Smart Order DSL v2 (ADR-0010). Additive only: v1 rows keep version=1 and
-- their original definition JSON; new columns default to safe values.
ALTER TABLE "conditional_rules" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN "token_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN "trigger_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditional_rules" ADD COLUMN "total_notional_executed" numeric NOT NULL DEFAULT 0;
