-- Idempotent migration: payment & voucher system (Sprint 5).
-- All statements use IF NOT EXISTS / guarded constraint blocks so re-applying
-- over a partially-created schema (tables seeded manually earlier) is safe.

-- CreateTable
CREATE TABLE IF NOT EXISTS "SubscriptionTier" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceMonthly" INTEGER NOT NULL,
    "priceYearly" INTEGER NOT NULL,
    "strategies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxPositions" INTEGER NOT NULL DEFAULT 1,
    "features" JSONB,
    "badge" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "grossAmount" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "finalAmount" INTEGER NOT NULL,
    "voucherId" TEXT,
    "voucherCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapToken" TEXT,
    "snapRedirectUrl" TEXT,
    "midtransTransactionId" TEXT,
    "paymentType" TEXT,
    "fraudStatus" TEXT,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "rawNotification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Voucher" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "maxDiscount" INTEGER,
    "minPurchase" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "maxUsesPerUser" INTEGER NOT NULL DEFAULT 1,
    "applicableTiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VoucherUsage" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "discountApplied" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentAuditLog" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "userId" TEXT,
    "orderId" TEXT,
    "event" TEXT NOT NULL,
    "detail" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionTier_key_key" ON "SubscriptionTier"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionTier_isActive_idx" ON "SubscriptionTier"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Subscription_userId_idx" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Subscription_endDate_idx" ON "Subscription"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_orderId_key" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_code_key" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Voucher_isActive_idx" ON "Voucher"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Voucher_deletedAt_idx" ON "Voucher"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VoucherUsage_paymentId_key" ON "VoucherUsage"("paymentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VoucherUsage_voucherId_userId_idx" ON "VoucherUsage"("voucherId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentAuditLog_paymentId_idx" ON "PaymentAuditLog"("paymentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentAuditLog_orderId_idx" ON "PaymentAuditLog"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentAuditLog_event_idx" ON "PaymentAuditLog"("event");

-- AddForeignKey (guarded: PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "VoucherUsage" ADD CONSTRAINT "VoucherUsage_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "VoucherUsage" ADD CONSTRAINT "VoucherUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "VoucherUsage" ADD CONSTRAINT "VoucherUsage_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
