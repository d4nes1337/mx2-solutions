-- Private-beta access boundary (waitlist + one-time invitation codes).
-- Additive only; existing active allowlist rows keep working unchanged
-- (grandfathering — owner decision 2026-07-23 Q1). Raw invite codes are never
-- stored: code_hash = SHA256(code), mirroring channel_link_codes.
-- ROLLBACK:
--   DROP TABLE IF EXISTS "invitations";
--   DROP TABLE IF EXISTS "waitlist_entries";

-- email is nullable: joining needs an email OR a wallet address (or both);
-- plain UNIQUE tolerates multiple NULLs, wallet-only dedupe lives in the store.
CREATE TABLE IF NOT EXISTS "waitlist_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text,
  "social_handle" text,
  "wallet_address" text,
  "trading_frequency" text,
  "use_case" text,
  "referral" text,
  "consent_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'waiting',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "waitlist_entries_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_entries_status_idx" ON "waitlist_entries" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_entries_wallet_idx" ON "waitlist_entries" ("wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" text NOT NULL,
  "issued_by" text NOT NULL,
  "note" text,
  "waitlist_entry_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "redeemed_by" text,
  "redeemed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_redeemed_by_idx" ON "invitations" ("redeemed_by");
