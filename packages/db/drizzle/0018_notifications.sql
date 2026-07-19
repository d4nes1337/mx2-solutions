-- Notifications + remote signing foundation (slice 1): external channel links
-- (Telegram/Discord), single-use linking codes, the transactional notification
-- outbox, single-use sign-link tokens, and the sessions.scope column that marks
-- restricted (non-browser) sessions. All additive.
-- ROLLBACK:
--   DROP TABLE "notification_channels";
--   DROP TABLE "channel_link_codes";
--   DROP TABLE "notification_outbox";
--   DROP TABLE "sign_link_tokens";
--   ALTER TABLE "sessions" DROP COLUMN "scope";
CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "channel" text NOT NULL,
  "external_id" text NOT NULL,
  "external_username" text,
  "status" text NOT NULL DEFAULT 'active',
  "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_channels_wallet_idx"
  ON "notification_channels" ("wallet_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_channels_external_idx"
  ON "notification_channels" ("channel", "external_id");
--> statement-breakpoint
-- One ACTIVE link per external account per channel (revoked history rows remain).
CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_active_external_unique"
  ON "notification_channels" ("channel", "external_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_link_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" text NOT NULL UNIQUE,
  "wallet_address" text NOT NULL,
  "channel" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_link_codes_wallet_idx"
  ON "channel_link_codes" ("wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" text NOT NULL,
  "kind" text NOT NULL,
  "dedupe_key" text NOT NULL UNIQUE,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_due_idx"
  ON "notification_outbox" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_wallet_idx"
  ON "notification_outbox" ("wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sign_link_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL UNIQUE,
  "wallet_address" text NOT NULL,
  "trigger_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sign_link_tokens_trigger_idx"
  ON "sign_link_tokens" ("trigger_id");
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "scope" jsonb;
