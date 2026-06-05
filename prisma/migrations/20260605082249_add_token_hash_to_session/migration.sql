-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "refreshTokenHash" TEXT,
ALTER COLUMN "refreshToken" DROP NOT NULL;
