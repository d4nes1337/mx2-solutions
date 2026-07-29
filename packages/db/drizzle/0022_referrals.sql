-- Referral system + per-user volume rollups (owner decisions 2026-07-28).
-- Additive only; legacy invitations/waitlist/allowlist untouched.
-- Referral codes are PLAINTEXT handles (re-displayable by design) — guessing
-- is mitigated by redemption rate limits, per-code caps, and audit events.
-- ROLLBACK:
--   DROP TABLE IF EXISTS "user_volume_stats";
--   DROP TABLE IF EXISTS "user_volume_daily";
--   DROP TABLE IF EXISTS "referral_redemptions";
--   DROP TABLE IF EXISTS "referral_codes";

CREATE TABLE IF NOT EXISTS "referral_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "owner_wallet" text,
  "max_uses" integer NOT NULL,
  "used_count" integer NOT NULL DEFAULT 0,
  "note" text,
  "created_by" text NOT NULL,
  "expires_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "disabled_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_codes_owner_wallet_idx" ON "referral_codes" ("owner_wallet");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_id" uuid NOT NULL,
  "wallet_address" text NOT NULL,
  "referrer_wallet" text,
  "redeemed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_redemptions_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_redemptions_code_id_idx" ON "referral_redemptions" ("code_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_volume_daily" (
  "wallet_address" text NOT NULL,
  "day" text NOT NULL,
  "volume_usd" numeric NOT NULL DEFAULT '0',
  "trade_count" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_volume_daily_wallet_day_idx" ON "user_volume_daily" ("wallet_address","day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_volume_daily_day_idx" ON "user_volume_daily" ("day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_volume_stats" (
  "wallet_address" text PRIMARY KEY,
  "proxy_wallet" text NOT NULL,
  "lifetime_volume_usd" numeric NOT NULL DEFAULT '0',
  "trade_count" integer NOT NULL DEFAULT 0,
  "last_trade_at" timestamp with time zone,
  "last_synced_timestamp" bigint NOT NULL DEFAULT 0,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
