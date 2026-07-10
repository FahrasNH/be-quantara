-- ─────────────────────────────────────────────────────────────────────────────
-- cleanup-test-users.sql — remove pentest / junk accounts from STAGING.
--
-- Targets the accounts seeded during security testing (XSS/SQLi probe rows):
--   admin2@test.com, xss@test.com, probe@test.com, and the "DROP TABLE" hacker
--   row (matched by its @test.com email, NOT by parsing the username).
--
-- Safety:
--   • Wrapped in a transaction — review the SELECT output, then COMMIT or ROLLBACK.
--   • Only deletes role = 'USER' (never an ADMIN / SUPER_ADMIN).
--   • Cascades (Bot, Trade, AuditLog, UserStrategy, Session) rely on the schema's
--     onDelete: Cascade relations — deleting the User removes its children.
--
-- Usage (on the VPS, from the BE repo):
--   psql "$DATABASE_URL" -f scripts/cleanup-test-users.sql
--   -- inspect the listed rows, then type:  COMMIT;   (or  ROLLBACK;  to abort)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- The exact set of test emails to purge. Add/remove lines as needed.
CREATE TEMP TABLE _purge (email text) ON COMMIT DROP;
INSERT INTO _purge (email) VALUES
  ('admin2@test.com'),
  ('xss@test.com'),
  ('probe@test.com'),
  ('test@test.com'),            -- the "; DROP TABLE users; --" hacker row
  ('test@test.com"; DROP TABLE users; --');  -- in case the literal string was stored as email

-- 1) Preview exactly what will be deleted — REVIEW THIS before committing.
SELECT u.id, u.email, u.username, u.role, u."createdAt"
FROM "User" u
JOIN _purge p ON u.email = p.email
WHERE u.role = 'USER'
ORDER BY u."createdAt";

-- 2) Delete (role-guarded: never touches an admin account).
DELETE FROM "User" u
USING _purge p
WHERE u.email = p.email
  AND u.role = 'USER';

-- 3) Confirm none of the target emails remain.
SELECT COUNT(*) AS remaining_test_users
FROM "User" u
JOIN _purge p ON u.email = p.email;

-- If the preview + counts look right:   COMMIT;
-- If anything looks off:                ROLLBACK;
COMMIT;
