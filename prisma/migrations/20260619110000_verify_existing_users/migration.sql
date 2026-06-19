-- Set emailVerifiedAt for users who registered BEFORE email verification was introduced.
-- These users were already accepted via the old flow (no verification required),
-- so they are considered implicitly verified.
UPDATE "User"
SET "emailVerifiedAt" = COALESCE("createdAt", NOW())
WHERE "emailVerifiedAt" IS NULL;
