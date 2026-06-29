CREATE TABLE "privy_wallets" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"privy_user_id" text NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"embedded_address" text NOT NULL,
	"policy_id" text,
	"allowances_bootstrapped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"session_signer_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "privy_wallets_embedded_idx" ON "privy_wallets" USING btree ("embedded_address");--> statement-breakpoint
CREATE INDEX "trading_delegations_wallet_idx" ON "trading_delegations" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "trading_delegations_status_idx" ON "trading_delegations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trading_delegations_expires_at_idx" ON "trading_delegations" USING btree ("expires_at");