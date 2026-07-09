-- Sprint 4 / WT-1 — Walk-Forward Parameter Tuning
-- Manual migration: adds ParameterSuggestion, ParameterVersion tables
-- and Bot.configOverrides column.

CREATE TABLE IF NOT EXISTS "ParameterSuggestion" (
  "id"              TEXT         NOT NULL PRIMARY KEY,
  "strategyKey"     TEXT         NOT NULL,
  "symbol"          TEXT         NOT NULL,
  "suggestedParams" JSONB        NOT NULL,
  "currentParams"   JSONB,
  "trainMetrics"    JSONB        NOT NULL,
  "validMetrics"    JSONB        NOT NULL,
  "trainDays"       INTEGER      NOT NULL DEFAULT 90,
  "validDays"       INTEGER      NOT NULL DEFAULT 30,
  "sampleSize"      INTEGER      NOT NULL,
  "sampleSizeValid" BOOLEAN      NOT NULL DEFAULT false,
  "status"          TEXT         NOT NULL DEFAULT 'pending',
  "appliedAt"       TIMESTAMP(3),
  "appliedBy"       TEXT,
  "rejectedAt"      TIMESTAMP(3),
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ParameterVersion" (
  "id"          TEXT         NOT NULL PRIMARY KEY,
  "strategyKey" TEXT         NOT NULL,
  "symbol"      TEXT,
  "params"      JSONB        NOT NULL,
  "source"      TEXT         NOT NULL DEFAULT 'manual',
  "appliedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy"   TEXT,
  "previousId"  TEXT,
  "pnlBefore"   DOUBLE PRECISION,
  "pnlAfter"    DOUBLE PRECISION,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ParameterSuggestion_strategyKey_symbol_idx" ON "ParameterSuggestion"("strategyKey", "symbol");
CREATE INDEX IF NOT EXISTS "ParameterSuggestion_status_idx"             ON "ParameterSuggestion"("status");
CREATE INDEX IF NOT EXISTS "ParameterSuggestion_createdAt_idx"          ON "ParameterSuggestion"("createdAt");
CREATE INDEX IF NOT EXISTS "ParameterVersion_strategyKey_symbol_idx"    ON "ParameterVersion"("strategyKey", "symbol");
CREATE INDEX IF NOT EXISTS "ParameterVersion_appliedAt_idx"             ON "ParameterVersion"("appliedAt");

-- Add configOverrides column to Bot (per-bot parameter overrides)
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "configOverrides" JSONB;
