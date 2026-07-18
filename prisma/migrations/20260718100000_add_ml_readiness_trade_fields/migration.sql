-- ============================================================
-- Migration: 20260718100000_add_ml_readiness_trade_fields
-- Sprint 16 / ML Data Readiness Phase 1
--
-- Adds top-level Trade columns + engine trades table ML fields.
-- ============================================================

-- Prisma Trade model (capital-T)
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "winningComponent" TEXT;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "signalDelayMs" INTEGER;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "pairTier" TEXT DEFAULT 'LIQUID';

-- Engine trades store (lowercase — live bot writes)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS winning_component TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS signal_delay_ms INTEGER DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pair_tier TEXT DEFAULT 'LIQUID';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_context JSONB;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_context JSONB;

CREATE INDEX IF NOT EXISTS idx_trades_pair_tier ON trades(pair_tier);
CREATE INDEX IF NOT EXISTS idx_trades_winning_component ON trades(winning_component);
