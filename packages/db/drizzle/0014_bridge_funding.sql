-- Bridge funding tracking (ADR-0017 follow-through): persisted per-user bridge
-- addresses (deposit AND withdrawal hops), deposit transfer tracking from the
-- provider status API, and the two-leg withdrawal ledger. All additive.
-- ROLLBACK:
--   DROP TABLE "bridge_withdrawals";
--   DROP TABLE "bridge_deposits";
--   DROP TABLE "bridge_addresses";
CREATE TABLE IF NOT EXISTS "bridge_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "deposit_wallet_address" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'deposit',
  "address_type" text NOT NULL,
  "address" text NOT NULL,
  "to_chain_id" text,
  "to_token_address" text,
  "recipient_address" text,
  "last_checked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_addresses_wallet_addr_unique"
  ON "bridge_addresses" ("wallet_address", "kind", "address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_addresses_wallet_idx" ON "bridge_addresses" ("wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bridge_deposits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "bridge_address_id" uuid NOT NULL,
  "from_chain_id" text NOT NULL DEFAULT '',
  "from_token_address" text NOT NULL DEFAULT '',
  "from_amount_base_unit" text NOT NULL DEFAULT '',
  "state" text NOT NULL DEFAULT 'detected',
  "provider_status" text NOT NULL DEFAULT '',
  "tx_hash" text,
  "provider_created_time_ms" bigint NOT NULL DEFAULT 0,
  "raw" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_deposits_dedupe_unique"
  ON "bridge_deposits" ("bridge_address_id", "from_chain_id", "from_token_address", "from_amount_base_unit", "provider_created_time_ms");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_deposits_wallet_idx" ON "bridge_deposits" ("wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bridge_withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "deposit_wallet_address" text NOT NULL,
  "destination_address" text NOT NULL,
  "to_chain_id" text NOT NULL,
  "to_token_address" text NOT NULL,
  "bridge_address_id" uuid,
  "amount_usd" numeric NOT NULL,
  "quote_id" text,
  "est_to_token_base_unit" text,
  "state" text NOT NULL DEFAULT 'requested',
  "relayer_transaction_id" text,
  "polygon_tx_hash" text,
  "bridge_tx_hash" text,
  "error" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_withdrawals_idem_unique"
  ON "bridge_withdrawals" ("wallet_address", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_withdrawals_wallet_idx" ON "bridge_withdrawals" ("wallet_address");
