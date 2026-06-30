CREATE TABLE "trading_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_wallet_address" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"signer_address" text NOT NULL,
	"funder_address" text,
	"signature_type" integer NOT NULL,
	"signing_mode" text NOT NULL,
	"status" text DEFAULT 'needs_credentials' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"privy_wallet_id" text,
	"deposit_wallet_address" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_account_clob_credentials" (
	"trading_account_id" uuid PRIMARY KEY NOT NULL,
	"owner_wallet_address" text NOT NULL,
	"encrypted_creds" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "trading_account_id" uuid;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "signer" text;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "signature_type" integer;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "signing_mode" text;--> statement-breakpoint
CREATE INDEX "trading_accounts_owner_idx" ON "trading_accounts" USING btree ("owner_wallet_address");--> statement-breakpoint
CREATE INDEX "trading_accounts_owner_primary_idx" ON "trading_accounts" USING btree ("owner_wallet_address","is_primary");--> statement-breakpoint
CREATE INDEX "trading_accounts_signer_idx" ON "trading_accounts" USING btree ("signer_address");--> statement-breakpoint
CREATE INDEX "trading_account_clob_credentials_owner_idx" ON "trading_account_clob_credentials" USING btree ("owner_wallet_address");--> statement-breakpoint
CREATE INDEX "order_intents_trading_account_idx" ON "order_intents" USING btree ("trading_account_id");
