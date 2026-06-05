-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "apiKey" TEXT,
    "apiSecret" TEXT,
    "apiPassphrase" TEXT,
    "exchangeType" TEXT DEFAULT 'bitget',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStrategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL DEFAULT 'ADAPTIVE_FUSION',
    "balanceTier" TEXT NOT NULL DEFAULT 'C',
    "riskPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 1,
    "leverage" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "capital" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "strategyKey" TEXT NOT NULL DEFAULT 'ADAPTIVE_FUSION',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winningTrades" INTEGER NOT NULL DEFAULT 0,
    "losingTrades" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "exit" DOUBLE PRECISION,
    "quantity" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotLog" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "UserStrategy_userId_key" ON "UserStrategy"("userId");

-- CreateIndex
CREATE INDEX "Bot_userId_idx" ON "Bot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Bot_userId_symbol_key" ON "Bot"("userId", "symbol");

-- CreateIndex
CREATE INDEX "Trade_botId_idx" ON "Trade"("botId");

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "BotLog_botId_idx" ON "BotLog"("botId");

-- CreateIndex
CREATE INDEX "BotLog_level_idx" ON "BotLog"("level");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "Session"("refreshToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "UserStrategy" ADD CONSTRAINT "UserStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLog" ADD CONSTRAINT "BotLog_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
