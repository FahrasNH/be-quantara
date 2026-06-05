-- AlterTable
ALTER TABLE "User" ADD COLUMN "apiPassphrase" TEXT;
ALTER TABLE "User" ADD COLUMN "exchangeType" TEXT DEFAULT 'bitget';
