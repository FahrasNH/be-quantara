-- Grok Confirm Gate bot settings + AI trade interaction audit log

ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "grokConfirmEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "grokConfirmTpAdjust" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "grokConfirmTpBandPct" DOUBLE PRECISION NOT NULL DEFAULT 15;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "grokConfirmTpRejectAction" TEXT NOT NULL DEFAULT 'skip';

CREATE TABLE IF NOT EXISTS "AiTradeInteraction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "symbol" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "parsed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTradeInteraction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiTradeInteraction_userId_idx" ON "AiTradeInteraction"("userId");
CREATE INDEX IF NOT EXISTS "AiTradeInteraction_botId_idx" ON "AiTradeInteraction"("botId");
CREATE INDEX IF NOT EXISTS "AiTradeInteraction_symbol_idx" ON "AiTradeInteraction"("symbol");
CREATE INDEX IF NOT EXISTS "AiTradeInteraction_createdAt_idx" ON "AiTradeInteraction"("createdAt");
