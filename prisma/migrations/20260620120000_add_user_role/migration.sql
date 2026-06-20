-- Add role-based access control to User (ADMIN-BE-01).
-- Creates the UserRole enum and a `role` column defaulting to USER so every
-- existing account stays a normal user until explicitly promoted.

DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role" "UserRole" NOT NULL DEFAULT 'USER';
