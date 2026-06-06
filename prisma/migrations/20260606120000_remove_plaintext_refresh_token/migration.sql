-- P1.3 Security Hardening: Remove plaintext refreshToken column from Session.
-- Token sekarang hanya disimpan sebagai bcrypt hash di refreshTokenHash.
-- IF EXISTS dipasang agar migration idempotent (aman dijalankan ulang).

ALTER TABLE "Session" DROP COLUMN IF EXISTS "refreshToken";
