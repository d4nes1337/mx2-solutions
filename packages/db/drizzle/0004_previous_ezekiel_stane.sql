CREATE TABLE "order_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"price" text NOT NULL,
	"size" text NOT NULL,
	"order_type" text NOT NULL,
	"funder" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"clob_order_id" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_intents_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "runtime_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_clob_credentials" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"encrypted_creds" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "order_intents_wallet_idx" ON "order_intents" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "order_intents_idempotency_key_idx" ON "order_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "order_intents_status_idx" ON "order_intents" USING btree ("status");