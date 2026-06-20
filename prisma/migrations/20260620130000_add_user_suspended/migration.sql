-- Add admin suspension to User (ADMIN-BE-03).
-- Non-null suspendedAt = account is suspended; AuthService.login rejects it.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);
