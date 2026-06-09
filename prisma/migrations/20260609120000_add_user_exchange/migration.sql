-- CreateTable
CREATE TABLE "UserExchange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeType" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "apiPassphrase" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserExchange_apiKeyHash_key" ON "UserExchange"("apiKeyHash");

-- CreateIndex
CREATE INDEX "UserExchange_userId_idx" ON "UserExchange"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserExchange_userId_exchangeType_key" ON "UserExchange"("userId", "exchangeType");

-- AddForeignKey
ALTER TABLE "UserExchange" ADD CONSTRAINT "UserExchange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing single-exchange credentials from User → UserExchange
INSERT INTO "UserExchange" ("id", "userId", "exchangeType", "apiKey", "apiSecret", "apiPassphrase", "apiKeyHash", "createdAt", "updatedAt")
SELECT
    ('ue_' || u."id" || '_' || COALESCE(u."exchangeType", 'bitget')),
    u."id",
    COALESCE(u."exchangeType", 'bitget'),
    u."apiKey",
    u."apiSecret",
    u."apiPassphrase",
    u."apiKeyHash",
    NOW(),
    NOW()
FROM "User" u
WHERE u."apiKey" IS NOT NULL
  AND u."apiSecret" IS NOT NULL
  AND u."apiKeyHash" IS NOT NULL
ON CONFLICT ("userId", "exchangeType") DO NOTHING;
