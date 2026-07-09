-- Sprint 5 / RL-4: MLShadowLog — stores shadow predictions for model evaluation
-- Apply manually: psql $DATABASE_URL -f this_file.sql

CREATE TABLE IF NOT EXISTS "MLShadowLog" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "tradeId"       TEXT,
  "pWin"          DOUBLE PRECISION NOT NULL,
  "threshold"     DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  "prediction"    TEXT NOT NULL,
  "actualOutcome" TEXT,
  "features"      JSONB,
  "strategyKey"   TEXT,
  "symbol"        TEXT,
  "regime"        TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MLShadowLog_tradeId_idx"          ON "MLShadowLog"("tradeId");
CREATE INDEX IF NOT EXISTS "MLShadowLog_createdAt_idx"         ON "MLShadowLog"("createdAt");
CREATE INDEX IF NOT EXISTS "MLShadowLog_strategyKey_symbol_idx" ON "MLShadowLog"("strategyKey", "symbol");
