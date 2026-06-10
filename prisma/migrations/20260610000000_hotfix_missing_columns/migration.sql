-- Hotfix: Add all columns that exist in schema.prisma but were never migrated.
-- Root cause: apiKeyHash was added to User model and db-pushed locally,
-- then migration add_user_exchange read it — but production never got the column.
-- This caused add_user_exchange (and add_strategy_group) to fail on production.
--
-- All statements use IF NOT EXISTS / DO-NOTHING guards so this is safe
-- to run regardless of partial-apply state.

-- ─── 1. User.apiKeyHash ──────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiKeyHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_apiKeyHash_key" ON "User"("apiKeyHash");

-- ─── 2. UserStrategy.tier ────────────────────────────────────────────────────
ALTER TABLE "UserStrategy" ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'FOUNDRY';

-- ─── 3. Bot.tpMode ───────────────────────────────────────────────────────────
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "tpMode" TEXT NOT NULL DEFAULT 'full';

-- ─── 4. UserExchange table (in case migration add_user_exchange failed) ──────
CREATE TABLE IF NOT EXISTS "UserExchange" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "exchangeType"  TEXT NOT NULL,
    "apiKey"        TEXT NOT NULL,
    "apiSecret"     TEXT NOT NULL,
    "apiPassphrase" TEXT,
    "apiKeyHash"    TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserExchange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserExchange_apiKeyHash_key"
    ON "UserExchange"("apiKeyHash");

CREATE INDEX IF NOT EXISTS "UserExchange_userId_idx"
    ON "UserExchange"("userId");

-- Check pg_class (relations) not pg_constraint: the original add_user_exchange
-- migration created this as a bare CREATE UNIQUE INDEX, so its name lives in
-- pg_class as an index — not as a named constraint. Checking pg_class covers
-- both the index-backed and constraint-backed cases.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'UserExchange_userId_exchangeType_key'
    ) THEN
        ALTER TABLE "UserExchange"
            ADD CONSTRAINT "UserExchange_userId_exchangeType_key"
            UNIQUE ("userId", "exchangeType");
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'UserExchange_userId_fkey'
    ) THEN
        ALTER TABLE "UserExchange"
            ADD CONSTRAINT "UserExchange_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── 5. Migrate existing User credentials → UserExchange ─────────────────────
-- Only runs for users that have API keys but no matching UserExchange row yet.
INSERT INTO "UserExchange" (
    "id", "userId", "exchangeType",
    "apiKey", "apiSecret", "apiPassphrase",
    "apiKeyHash", "createdAt", "updatedAt"
)
SELECT
    'ue_' || u."id" || '_' || COALESCE(u."exchangeType", 'bitget'),
    u."id",
    COALESCE(u."exchangeType", 'bitget'),
    u."apiKey",
    u."apiSecret",
    u."apiPassphrase",
    u."apiKeyHash",
    NOW(),
    NOW()
FROM "User" u
WHERE u."apiKey"    IS NOT NULL
  AND u."apiSecret" IS NOT NULL
  AND u."apiKeyHash" IS NOT NULL
ON CONFLICT ("userId", "exchangeType") DO NOTHING;

-- ─── 6. Bot strategy group cols (in case add_strategy_group failed) ──────────
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "strategyGroup"      TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "capitalPerStrategy" DOUBLE PRECISION DEFAULT 0;

-- ─── 7. Trade attribution cols (in case add_strategy_group failed) ───────────
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "firedByStrategy" TEXT;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "slPrice"         DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "tpPrice"         DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "slMultiplier"    DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "tpMultiplier"    DOUBLE PRECISION;
