-- Keep staging validation separate from live executions.
ALTER TABLE "MLShadowLog"
  ADD COLUMN IF NOT EXISTS "mode" TEXT;

-- Historical shadow rows are linked to the engine `trades` table by tradeId.
-- Rows that cannot be resolved remain NULL and are intentionally excluded from
-- the staging promotion gate until their provenance is known.
DO $$
BEGIN
  IF to_regclass('public.trades') IS NOT NULL THEN
    UPDATE "MLShadowLog" AS l
       SET "mode" = CASE WHEN t.dry_run = 1 THEN 'staging' ELSE 'live' END
      FROM trades AS t
     WHERE l."mode" IS NULL
       AND t.id::text = l."tradeId";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "MLShadowLog_mode_createdAt_idx"
  ON "MLShadowLog"("mode", "createdAt");

CREATE INDEX IF NOT EXISTS "MLShadowLog_mode_strategy_symbol_idx"
  ON "MLShadowLog"("mode", "strategyKey", "symbol");
