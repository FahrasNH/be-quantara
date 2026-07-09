-- ============================================================
-- Migration: 20260709020000_add_trade_feature_context
-- Sprint 1 / FS-2 + FS-4
--
-- Adds Feature Store columns to Trade and creates the
-- StrategyPerformance aggregation table.
-- ============================================================

-- FS-2: Add JSONB feature context columns to Trade
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "entryContext" JSONB;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "exitContext"  JSONB;

-- Optional GIN index for fast regime / strategyKey filtering
CREATE INDEX IF NOT EXISTS "Trade_entryContext_gin"
  ON "Trade" USING GIN ("entryContext" jsonb_path_ops);

-- FS-4: StrategyPerformance daily aggregation table
CREATE TABLE IF NOT EXISTS "StrategyPerformance" (
  "id"             TEXT      NOT NULL,
  "strategyKey"    TEXT      NOT NULL,
  "symbol"         TEXT      NOT NULL,
  "regime"         TEXT      NOT NULL,
  "tradeType"      TEXT,
  "pairTier"       TEXT,
  "periodDate"     TIMESTAMP(3) NOT NULL,

  "tradeCount"     INTEGER   NOT NULL DEFAULT 0,
  "winCount"       INTEGER   NOT NULL DEFAULT 0,
  "lossCount"      INTEGER   NOT NULL DEFAULT 0,
  "winRate"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "profitFactor"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avgPnlPct"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "maxDrawdownPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sharpeRatio"    DOUBLE PRECISION,
  "avgHoldingMs"   DOUBLE PRECISION,

  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StrategyPerformance_pkey" PRIMARY KEY ("id")
);

-- Unique constraint prevents duplicate daily aggregations
CREATE UNIQUE INDEX IF NOT EXISTS "StrategyPerformance_unique_daily"
  ON "StrategyPerformance" ("strategyKey", "symbol", "regime",
                            COALESCE("tradeType", ''), COALESCE("pairTier", ''),
                            "periodDate");

-- Lookup indexes
CREATE INDEX IF NOT EXISTS "StrategyPerformance_strategyKey_symbol_idx"
  ON "StrategyPerformance" ("strategyKey", "symbol");

CREATE INDEX IF NOT EXISTS "StrategyPerformance_periodDate_idx"
  ON "StrategyPerformance" ("periodDate");
