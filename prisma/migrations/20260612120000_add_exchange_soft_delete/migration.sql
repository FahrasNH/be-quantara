-- Add soft-delete + label columns to UserExchange
-- Root cause: schema.prisma had these columns defined but migration was never created.
-- All statements use IF NOT EXISTS guards for safety.

ALTER TABLE "UserExchange" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "UserExchange" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Index for soft-delete queries (find active exchanges where deletedAt IS NULL)
CREATE INDEX IF NOT EXISTS "UserExchange_deletedAt_idx" ON "UserExchange"("deletedAt");
