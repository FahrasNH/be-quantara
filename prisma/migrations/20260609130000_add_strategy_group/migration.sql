-- Multi-Strategy per Coin (Quantara feature)
-- Additive only — backward-compatible. Existing bots keep using `strategyKey`;
-- `strategyGroup` empty array = legacy single-strategy mode.

-- AlterTable: Bot — strategy group + equal-weight capital split
ALTER TABLE "Bot" ADD COLUMN     "capitalPerStrategy" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "strategyGroup" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: Trade — per-strategy attribution + SL/TP audit trail
ALTER TABLE "Trade" ADD COLUMN     "firedByStrategy" TEXT,
ADD COLUMN     "slMultiplier" DOUBLE PRECISION,
ADD COLUMN     "slPrice" DOUBLE PRECISION,
ADD COLUMN     "tpMultiplier" DOUBLE PRECISION,
ADD COLUMN     "tpPrice" DOUBLE PRECISION;
