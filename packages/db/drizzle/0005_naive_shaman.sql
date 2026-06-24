CREATE TABLE "conditional_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"status" text DEFAULT 'ACTIVE_WAITING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"true_since" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_user' NOT NULL,
	"order_intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conditional_rules_wallet_idx" ON "conditional_rules" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "conditional_rules_status_idx" ON "conditional_rules" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conditional_rules_token_idx" ON "conditional_rules" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "rule_triggers_rule_idx" ON "rule_triggers" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "rule_triggers_wallet_idx" ON "rule_triggers" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "rule_triggers_status_idx" ON "rule_triggers" USING btree ("status");