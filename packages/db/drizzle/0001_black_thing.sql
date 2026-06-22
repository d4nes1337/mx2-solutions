CREATE TABLE "market_snapshots" (
	"token_id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"bids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_trade_price" text,
	"mid_price" text,
	"source" text DEFAULT 'rest' NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "market_snapshots_condition_id_idx" ON "market_snapshots" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "market_snapshots_updated_at_idx" ON "market_snapshots" USING btree ("updated_at");