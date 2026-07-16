-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'IN_PREPARATION', 'DOCUMENTS_REQUIRED', 'VISA_PROCESSING', 'READY_FOR_TRAVEL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "staff_assignment" ADD COLUMN     "bookingId" TEXT;

-- Replace the two-target lead/client XOR constraint with a three-target
-- lead/client/booking XOR constraint now that bookingId exists.
ALTER TABLE "staff_assignment"
  DROP CONSTRAINT "staff_assignment_lead_xor_client";

ALTER TABLE "staff_assignment"
  ADD CONSTRAINT "staff_assignment_lead_xor_client_xor_booking"
  CHECK (num_nonnulls("leadId", "clientId", "bookingId") = 1);

-- Allow at most one active assignment per booking
CREATE UNIQUE INDEX "staff_assignment_active_booking_key"
  ON "staff_assignment" ("bookingId")
  WHERE "endedAt" IS NULL AND "bookingId" IS NOT NULL;

-- CreateTable
CREATE TABLE "booking" (
    "id" TEXT NOT NULL,
    "bookingReference" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "proposalVersionId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "tourPackageName" TEXT,
    "destination" TEXT,
    "travelStartDate" DATE,
    "travelEndDate" DATE,
    "travelerCount" INTEGER,
    "includedServices" TEXT,
    "excludedServices" TEXT,
    "specialRequests" TEXT,
    "internalNotes" TEXT,
    "clientVisibleNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- Booking validation constraints
ALTER TABLE "booking"
  ADD CONSTRAINT "booking_traveler_count_positive"
  CHECK ("travelerCount" IS NULL OR "travelerCount" > 0);

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_travel_dates_order"
  CHECK (
    "travelStartDate" IS NULL
    OR "travelEndDate" IS NULL
    OR "travelStartDate" <= "travelEndDate"
  );

-- CreateTable
CREATE TABLE "booking_status_history" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "previousStatus" "BookingStatus",
    "newStatus" "BookingStatus" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id")
);

-- Enforce that every status-history row records an actual change
ALTER TABLE "booking_status_history"
  ADD CONSTRAINT "booking_status_history_status_changed"
  CHECK (
    "previousStatus" IS NULL
    OR "previousStatus" != "newStatus"
  );

-- CreateIndex
CREATE UNIQUE INDEX "booking_bookingReference_key" ON "booking"("bookingReference");

-- CreateIndex
CREATE UNIQUE INDEX "booking_proposalVersionId_key" ON "booking"("proposalVersionId");

-- CreateIndex
CREATE INDEX "booking_clientId_idx" ON "booking"("clientId");

-- CreateIndex
CREATE INDEX "booking_status_idx" ON "booking"("status");

-- CreateIndex
CREATE INDEX "booking_status_history_bookingId_createdAt_idx" ON "booking_status_history"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "booking_status_history_changedByUserId_idx" ON "booking_status_history"("changedByUserId");

-- CreateIndex
CREATE INDEX "booking_status_history_createdAt_idx" ON "booking_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "staff_assignment_bookingId_endedAt_idx" ON "staff_assignment"("bookingId", "endedAt");

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "proposal_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
