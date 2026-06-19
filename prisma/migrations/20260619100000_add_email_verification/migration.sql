-- AddColumn emailVerifiedAt and emailVerificationToken to User
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerificationToken" TEXT;

-- CreateIndex for unique emailVerificationToken
CREATE UNIQUE INDEX "User_emailVerificationToken_key" ON "User"("emailVerificationToken");
