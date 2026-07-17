-- CreateEnum
CREATE TYPE "VisaCaseStatus" AS ENUM ('OPENED', 'REQUIREMENTS_PENDING', 'UNDER_REVIEW', 'ADDITIONAL_INFORMATION_REQUIRED', 'READY_FOR_SUBMISSION', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "relatedVisaCaseId" TEXT;

-- Replace the two-target Booking/Proposal exclusivity constraint with a
-- three-target Booking/Proposal/VisaCase constraint now that
-- relatedVisaCaseId exists.
ALTER TABLE "conversation"
  DROP CONSTRAINT "conversation_related_record_exclusive";

ALTER TABLE "conversation"
  ADD CONSTRAINT "conversation_related_record_exclusive"
  CHECK (num_nonnulls("relatedBookingId", "relatedProposalId", "relatedVisaCaseId") <= 1);

-- AlterTable
ALTER TABLE "staff_assignment" ADD COLUMN     "visaCaseId" TEXT;

-- Replace the three-target lead/client/booking XOR constraint with a
-- four-target lead/client/booking/visa_case XOR constraint now that
-- visaCaseId exists.
ALTER TABLE "staff_assignment"
  DROP CONSTRAINT "staff_assignment_lead_xor_client_xor_booking";

ALTER TABLE "staff_assignment"
  ADD CONSTRAINT "staff_assignment_lead_xor_client_xor_booking_xor_visa_case"
  CHECK (num_nonnulls("leadId", "clientId", "bookingId", "visaCaseId") = 1);

-- Allow at most one active assignment per visa case
CREATE UNIQUE INDEX "staff_assignment_active_visa_case_key"
  ON "staff_assignment" ("visaCaseId")
  WHERE "endedAt" IS NULL AND "visaCaseId" IS NOT NULL;

-- CreateTable
CREATE TABLE "visa_case" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" "VisaCaseStatus" NOT NULL DEFAULT 'OPENED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visa_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visa_status_history" (
    "id" TEXT NOT NULL,
    "visaCaseId" TEXT NOT NULL,
    "previousStatus" "VisaCaseStatus",
    "newStatus" "VisaCaseStatus" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visa_status_history_pkey" PRIMARY KEY ("id")
);

-- Enforce that every status-history row records an actual change
ALTER TABLE "visa_status_history"
  ADD CONSTRAINT "visa_status_history_status_changed"
  CHECK ("previousStatus" IS NULL OR "previousStatus" <> "newStatus");

-- CreateIndex
CREATE UNIQUE INDEX "visa_case_bookingId_key" ON "visa_case"("bookingId");

-- CreateIndex
CREATE INDEX "visa_case_clientId_idx" ON "visa_case"("clientId");

-- CreateIndex
CREATE INDEX "visa_case_status_idx" ON "visa_case"("status");

-- CreateIndex
CREATE INDEX "visa_status_history_visaCaseId_createdAt_idx" ON "visa_status_history"("visaCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "visa_status_history_changedByUserId_idx" ON "visa_status_history"("changedByUserId");

-- CreateIndex
CREATE INDEX "visa_status_history_createdAt_idx" ON "visa_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "conversation_relatedVisaCaseId_idx" ON "conversation"("relatedVisaCaseId");

-- CreateIndex
CREATE INDEX "staff_assignment_visaCaseId_endedAt_idx" ON "staff_assignment"("visaCaseId", "endedAt");

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_visaCaseId_fkey" FOREIGN KEY ("visaCaseId") REFERENCES "visa_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_relatedVisaCaseId_fkey" FOREIGN KEY ("relatedVisaCaseId") REFERENCES "visa_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_case" ADD CONSTRAINT "visa_case_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_case" ADD CONSTRAINT "visa_case_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_status_history" ADD CONSTRAINT "visa_status_history_visaCaseId_fkey" FOREIGN KEY ("visaCaseId") REFERENCES "visa_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_status_history" ADD CONSTRAINT "visa_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
