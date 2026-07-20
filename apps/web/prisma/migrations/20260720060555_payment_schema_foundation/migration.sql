-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'FAILED', 'REFUNDED', 'REVERSED');

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "currencyCode" TEXT,
ADD COLUMN     "totalAmount" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "paymentId" TEXT;

-- CreateTable
CREATE TABLE "payment_plan" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "proposedByStaffUserId" TEXT NOT NULL,
    "approvedByStaffUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment" (
    "id" TEXT NOT NULL,
    "paymentPlanId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "isDeposit" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(18,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_history" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "previousStatus" "PaymentStatus",
    "newStatus" "PaymentStatus" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "installmentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "allocatedByStaffUserId" TEXT NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation_reversal" (
    "id" TEXT NOT NULL,
    "paymentAllocationId" TEXT NOT NULL,
    "reversedByStaffUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_reversal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "performedByStaffUserId" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refund_allocation" (
    "id" TEXT NOT NULL,
    "paymentRefundId" TEXT NOT NULL,
    "paymentAllocationId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refund_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "issuedByStaffUserId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_plan_bookingId_key" ON "payment_plan"("bookingId");

-- CreateIndex
CREATE INDEX "payment_plan_clientId_idx" ON "payment_plan"("clientId");

-- CreateIndex
CREATE INDEX "payment_plan_proposedByStaffUserId_idx" ON "payment_plan"("proposedByStaffUserId");

-- CreateIndex
CREATE INDEX "payment_plan_approvedByStaffUserId_idx" ON "payment_plan"("approvedByStaffUserId");

-- CreateIndex
CREATE INDEX "installment_paymentPlanId_dueDate_idx" ON "installment"("paymentPlanId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "installment_paymentPlanId_sequenceNumber_key" ON "installment"("paymentPlanId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "payment_bookingId_status_idx" ON "payment"("bookingId", "status");

-- CreateIndex
CREATE INDEX "payment_clientId_idx" ON "payment"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_status_history_idempotencyKey_key" ON "payment_status_history"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_status_history_paymentId_createdAt_idx" ON "payment_status_history"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_status_history_changedByUserId_idx" ON "payment_status_history"("changedByUserId");

-- CreateIndex
CREATE INDEX "payment_status_history_createdAt_idx" ON "payment_status_history"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_idempotencyKey_key" ON "payment_allocation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_allocation_paymentId_idx" ON "payment_allocation"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocation_installmentId_idx" ON "payment_allocation"("installmentId");

-- CreateIndex
CREATE INDEX "payment_allocation_allocatedByStaffUserId_idx" ON "payment_allocation"("allocatedByStaffUserId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_reversal_paymentAllocationId_key" ON "payment_allocation_reversal"("paymentAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_reversal_idempotencyKey_key" ON "payment_allocation_reversal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_allocation_reversal_reversedByStaffUserId_idx" ON "payment_allocation_reversal"("reversedByStaffUserId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refund_idempotencyKey_key" ON "payment_refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_refund_paymentId_idx" ON "payment_refund"("paymentId");

-- CreateIndex
CREATE INDEX "payment_refund_performedByStaffUserId_idx" ON "payment_refund"("performedByStaffUserId");

-- CreateIndex
CREATE INDEX "payment_refund_allocation_paymentRefundId_idx" ON "payment_refund_allocation"("paymentRefundId");

-- CreateIndex
CREATE INDEX "payment_refund_allocation_paymentAllocationId_idx" ON "payment_refund_allocation"("paymentAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refund_allocation_paymentRefundId_paymentAllocation_key" ON "payment_refund_allocation"("paymentRefundId", "paymentAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_paymentId_key" ON "receipt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_receiptNumber_key" ON "receipt"("receiptNumber");

-- CreateIndex
CREATE INDEX "receipt_issuedByStaffUserId_idx" ON "receipt"("issuedByStaffUserId");

-- CreateIndex
CREATE INDEX "document_paymentId_idx" ON "document"("paymentId");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan" ADD CONSTRAINT "payment_plan_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan" ADD CONSTRAINT "payment_plan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan" ADD CONSTRAINT "payment_plan_proposedByStaffUserId_fkey" FOREIGN KEY ("proposedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_plan" ADD CONSTRAINT "payment_plan_approvedByStaffUserId_fkey" FOREIGN KEY ("approvedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment" ADD CONSTRAINT "installment_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_allocatedByStaffUserId_fkey" FOREIGN KEY ("allocatedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_reversal" ADD CONSTRAINT "payment_allocation_reversal_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "payment_allocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation_reversal" ADD CONSTRAINT "payment_allocation_reversal_reversedByStaffUserId_fkey" FOREIGN KEY ("reversedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_performedByStaffUserId_fkey" FOREIGN KEY ("performedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refund_allocation" ADD CONSTRAINT "payment_refund_allocation_paymentRefundId_fkey" FOREIGN KEY ("paymentRefundId") REFERENCES "payment_refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refund_allocation" ADD CONSTRAINT "payment_refund_allocation_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "payment_allocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_issuedByStaffUserId_fkey" FOREIGN KEY ("issuedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- Manually added: CHECK constraints and one partial unique index
-- Prisma's schema language cannot express (docs/HERITAGE_V3_DECISIONS_LOG.md
-- D-019; see each constraint's corresponding model doc comment in
-- schema.prisma for its full rationale). Reviewed, not yet applied.
-- ============================================================

-- A Booking's total amount, once set, must be positive.
ALTER TABLE "booking" ADD CONSTRAINT "booking_total_amount_positive"
    CHECK ("totalAmount" IS NULL OR "totalAmount" > 0);

-- A Booking's total amount and currency code must be set together or not at all.
ALTER TABLE "booking" ADD CONSTRAINT "booking_financials_pairing"
    CHECK (("totalAmount" IS NULL) = ("currencyCode" IS NULL));

-- A Booking's currency code, once set, must be exactly three uppercase letters.
ALTER TABLE "booking" ADD CONSTRAINT "booking_currency_code_format"
    CHECK ("currencyCode" IS NULL OR "currencyCode" ~ '^[A-Z]{3}$');

-- A PaymentPlan's approval timestamp and approving staff member must be set together or not at all.
ALTER TABLE "payment_plan"
    ADD CONSTRAINT "payment_plan_approval_pairing"
    CHECK (("approvedAt" IS NULL) = ("approvedByStaffUserId" IS NULL));

-- An Installment's amount must be positive.
ALTER TABLE "installment" ADD CONSTRAINT "installment_amount_positive"
    CHECK ("amount" > 0);

-- A Payment's amount must be positive.
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_positive"
    CHECK ("amount" > 0);

-- Every status-history row must record an actual status change.
ALTER TABLE "payment_status_history"
    ADD CONSTRAINT "payment_status_history_status_changed"
    CHECK ("previousStatus" IS NULL OR "previousStatus" <> "newStatus");

-- Every real transition after the initial PENDING record requires a non-blank reason.
ALTER TABLE "payment_status_history"
    ADD CONSTRAINT "payment_status_history_reason_required"
    CHECK (
        "previousStatus" IS NULL
        OR COALESCE(length(btrim("reason")), 0) > 0
    );

-- Transitions to CONFIRMED, REVERSED, or REFUNDED require an idempotency key.
ALTER TABLE "payment_status_history"
    ADD CONSTRAINT "payment_status_history_idempotency_key_required"
    CHECK (
        "newStatus" NOT IN ('CONFIRMED', 'REVERSED', 'REFUNDED')
        OR "idempotencyKey" IS NOT NULL
    );

-- A PaymentAllocation's amount must be positive.
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_amount_positive"
    CHECK ("amount" > 0);

-- Every allocation reversal requires a non-blank reason.
ALTER TABLE "payment_allocation_reversal"
    ADD CONSTRAINT "payment_allocation_reversal_reason_required"
    CHECK (COALESCE(length(btrim("reason")), 0) > 0);

-- A PaymentRefund's amount must be positive.
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_amount_positive"
    CHECK ("amount" > 0);

-- Every refund requires a non-blank reason.
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_reason_required"
    CHECK (COALESCE(length(btrim("reason")), 0) > 0);

-- A PaymentRefundAllocation's amount must be positive.
ALTER TABLE "payment_refund_allocation"
    ADD CONSTRAINT "payment_refund_allocation_amount_positive"
    CHECK ("amount" > 0);

-- A Receipt's amount must be positive.
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_amount_positive"
    CHECK ("amount" > 0);

-- A Receipt's currency code must be exactly three uppercase letters.
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_currency_code_format"
    CHECK ("currencyCode" ~ '^[A-Z]{3}$');

-- Replace the two-target Booking/VisaCase exclusivity constraint with a
-- three-target Booking/VisaCase/Payment constraint now that paymentId
-- exists.
ALTER TABLE "document"
    DROP CONSTRAINT "document_context_exclusive";

ALTER TABLE "document"
    ADD CONSTRAINT "document_context_exclusive"
    CHECK (num_nonnulls("bookingId", "visaCaseId", "paymentId") <= 1);

-- Allow at most one deposit Installment per PaymentPlan
CREATE UNIQUE INDEX "installment_active_deposit_key"
    ON "installment" ("paymentPlanId")
    WHERE "isDeposit" = true;
