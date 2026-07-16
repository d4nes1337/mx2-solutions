-- Trailing-condition watermark runtime (additive). Rows whose strategies have
-- no trailing conditions keep NULL. Shape (keyed by trailing ConditionNode id):
--   { "<nodeId>": { "value": 0.62, "armedAtMs": 1784000000000, "updatedAtMs": 1784000600000 } }
-- ROLLBACK: ALTER TABLE "conditional_rules" DROP COLUMN "runtime_watermarks";
ALTER TABLE "conditional_rules" ADD COLUMN "runtime_watermarks" jsonb;
