-- Sprint 16: Research Dataset SSOT (TradeResearchDataset)
CREATE TABLE "TradeResearchDataset" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "backtestId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "component" TEXT,
    "tradeType" TEXT,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "entryTime" TIMESTAMP(3) NOT NULL,
    "exitTime" TIMESTAMP(3),
    "pnlGross" DOUBLE PRECISION,
    "pnlNet" DOUBLE PRECISION,
    "fee" DOUBLE PRECISION,
    "result" TEXT,
    "exitReason" TEXT,
    "holdDurationMinutes" DOUBLE PRECISION,
    "sessionName" TEXT,
    "dailyRegime" TEXT,
    "htfTrend" TEXT,
    "atr" DOUBLE PRECISION,
    "atrPercent" DOUBLE PRECISION,
    "volatilityBucket" TEXT,
    "gradedScore" DOUBLE PRECISION,
    "gradedScoreBreakdown" JSONB,
    "scoringStrategyKey" TEXT,
    "featureScores" JSONB,
    "mfe" DOUBLE PRECISION,
    "mae" DOUBLE PRECISION,
    "mfePercent" DOUBLE PRECISION,
    "maePercent" DOUBLE PRECISION,
    "realizedRr" DOUBLE PRECISION,
    "holdDays" DOUBLE PRECISION,
    "entryReasons" JSONB,
    "exitReasons" JSONB,
    "sourceFile" TEXT,
    "dataQualityFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "migrationBatch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeResearchDataset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradeResearchDataset_tradeId_key" ON "TradeResearchDataset"("tradeId");
CREATE INDEX "TradeResearchDataset_strategyKey_idx" ON "TradeResearchDataset"("strategyKey");
CREATE INDEX "TradeResearchDataset_symbol_idx" ON "TradeResearchDataset"("symbol");
CREATE INDEX "TradeResearchDataset_result_idx" ON "TradeResearchDataset"("result");
CREATE INDEX "TradeResearchDataset_gradedScore_idx" ON "TradeResearchDataset"("gradedScore");
CREATE INDEX "TradeResearchDataset_migrationBatch_idx" ON "TradeResearchDataset"("migrationBatch");
CREATE INDEX "TradeResearchDataset_entryTime_idx" ON "TradeResearchDataset"("entryTime");
