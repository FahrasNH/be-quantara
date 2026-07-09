-- Sprint 3 / MS-1: MetaSelectorRecommendation table
-- Manual migration (do NOT run prisma migrate dev)

CREATE TABLE IF NOT EXISTS "MetaSelectorRecommendation" (
  "id"               TEXT             NOT NULL,
  "symbol"           TEXT             NOT NULL,
  "regime"           TEXT             NOT NULL,
  "regimeConfidence" DOUBLE PRECISION NOT NULL,
  "mode"             TEXT             NOT NULL DEFAULT 'shadow',
  "recommendations"  JSONB            NOT NULL,
  "actualStrategy"   TEXT,
  "actualOutcome"    TEXT,
  "tradeId"          TEXT,
  "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MetaSelectorRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MetaSelectorRecommendation_symbol_regime_idx"
  ON "MetaSelectorRecommendation"("symbol", "regime");

CREATE INDEX IF NOT EXISTS "MetaSelectorRecommendation_createdAt_idx"
  ON "MetaSelectorRecommendation"("createdAt");

CREATE INDEX IF NOT EXISTS "MetaSelectorRecommendation_mode_idx"
  ON "MetaSelectorRecommendation"("mode");
