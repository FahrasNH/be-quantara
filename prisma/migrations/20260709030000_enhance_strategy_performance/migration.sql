-- Sprint 2 / PA-1: Enhance StrategyPerformance with additional analytics fields
-- Idempotent: uses ALTER TABLE ... ADD COLUMN IF NOT EXISTS

ALTER TABLE "StrategyPerformance"
  ADD COLUMN IF NOT EXISTS "sortino"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "expectancy"       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "avgRr"            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "avgHoldingHours"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "period"           TEXT NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS "sampleSizeValid"  BOOLEAN NOT NULL DEFAULT false;
