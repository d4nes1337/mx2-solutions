-- Rolling series bindings (ADR-0028): an order action may target a recurring
-- series ("BTC Up or Down 5m") instead of one fixed market, re-resolving the
-- live window each time it fires.
--
-- Both columns are DENORMALIZED runtime/indexing state. The definition JSON
-- stays the source of truth and is never rewritten as windows roll, so
-- definition_hash remains stable across windows (D-020).
--
-- series_slug              — which recurring series this strategy rolls on
--                            (NULL for every existing, fixed-market strategy).
-- last_series_window_start — unix ms of the last window actually traded; the
--                            "at most one entry per window" guarantee is
--                            enforced against it, so it must survive restarts.
--
-- Additive only; no backfill needed (NULL means "not a rolling strategy").
-- ROLLBACK:
--   DROP INDEX IF EXISTS "conditional_rules_series_idx";
--   ALTER TABLE "conditional_rules" DROP COLUMN IF EXISTS "last_series_window_start";
--   ALTER TABLE "conditional_rules" DROP COLUMN IF EXISTS "series_slug";
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "series_slug" text;
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "last_series_window_start" bigint;
CREATE INDEX IF NOT EXISTS "conditional_rules_series_idx"
  ON "conditional_rules" ("series_slug")
  WHERE "series_slug" IS NOT NULL;
