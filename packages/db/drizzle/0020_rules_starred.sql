-- Smart Orders dashboard starring: starred strategies float to the top of
-- their section. User-set, carried over on supersede (like tags). Additive.
-- ROLLBACK: ALTER TABLE "conditional_rules" DROP COLUMN "starred_at";
ALTER TABLE "conditional_rules" ADD COLUMN IF NOT EXISTS "starred_at" timestamp with time zone;
