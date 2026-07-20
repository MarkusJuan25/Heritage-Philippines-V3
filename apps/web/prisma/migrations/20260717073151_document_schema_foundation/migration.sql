-- CreateEnum
CREATE TYPE "DocumentReviewOutcome" AS ENUM ('APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED');

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bookingId" TEXT,
    "visaCaseId" TEXT,
    "documentRequirementId" TEXT,
    "category" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousDocumentId" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "uploadedByStaffUserId" TEXT,
    "uploadedByClientProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_requirement" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "visaCaseId" TEXT,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_review" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "outcome" "DocumentReviewOutcome" NOT NULL,
    "reviewedByUserId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_previousDocumentId_key" ON "document"("previousDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_storageKey_key" ON "document"("storageKey");

-- CreateIndex
CREATE INDEX "document_clientId_idx" ON "document"("clientId");

-- CreateIndex
CREATE INDEX "document_bookingId_idx" ON "document"("bookingId");

-- CreateIndex
CREATE INDEX "document_visaCaseId_idx" ON "document"("visaCaseId");

-- CreateIndex
CREATE INDEX "document_documentRequirementId_idx" ON "document"("documentRequirementId");

-- CreateIndex
CREATE INDEX "document_category_idx" ON "document"("category");

-- CreateIndex
CREATE INDEX "document_uploadedByStaffUserId_idx" ON "document"("uploadedByStaffUserId");

-- CreateIndex
CREATE INDEX "document_uploadedByClientProfileId_idx" ON "document"("uploadedByClientProfileId");

-- CreateIndex
CREATE INDEX "document_requirement_bookingId_category_idx" ON "document_requirement"("bookingId", "category");

-- CreateIndex
CREATE INDEX "document_requirement_visaCaseId_category_idx" ON "document_requirement"("visaCaseId", "category");

-- CreateIndex
CREATE INDEX "document_review_documentId_reviewedAt_idx" ON "document_review"("documentId", "reviewedAt");

-- CreateIndex
CREATE INDEX "document_review_reviewedByUserId_idx" ON "document_review"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_visaCaseId_fkey" FOREIGN KEY ("visaCaseId") REFERENCES "visa_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_documentRequirementId_fkey" FOREIGN KEY ("documentRequirementId") REFERENCES "document_requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_previousDocumentId_fkey" FOREIGN KEY ("previousDocumentId") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploadedByStaffUserId_fkey" FOREIGN KEY ("uploadedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploadedByClientProfileId_fkey" FOREIGN KEY ("uploadedByClientProfileId") REFERENCES "client_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirement" ADD CONSTRAINT "document_requirement_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirement" ADD CONSTRAINT "document_requirement_visaCaseId_fkey" FOREIGN KEY ("visaCaseId") REFERENCES "visa_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DocumentRequirement must target exactly one Booking or VisaCase.
ALTER TABLE "document_requirement" ADD CONSTRAINT "document_requirement_target_exclusive"
    CHECK (num_nonnulls("bookingId", "visaCaseId") = 1);

-- A Document may target a Booking, a VisaCase, or neither, but never both.
ALTER TABLE "document" ADD CONSTRAINT "document_context_exclusive"
    CHECK (num_nonnulls("bookingId", "visaCaseId") <= 1);

-- Every Document must identify exactly one uploader path.
ALTER TABLE "document" ADD CONSTRAINT "document_uploader_path_exclusive"
    CHECK (num_nonnulls("uploadedByStaffUserId", "uploadedByClientProfileId") = 1);

-- Document versions must be positive integers.
ALTER TABLE "document" ADD CONSTRAINT "document_version_positive"
    CHECK ("version" >= 1);

-- A Document must not directly identify itself as its predecessor.
ALTER TABLE "document" ADD CONSTRAINT "document_previous_not_self"
    CHECK ("previousDocumentId" IS NULL OR "previousDocumentId" <> "id");

-- Rejection and replacement requests require a trimmed, nonblank reason.
ALTER TABLE "document_review" ADD CONSTRAINT "document_review_reason_required"
    CHECK (
        "outcome" NOT IN ('REJECTED', 'REPLACEMENT_REQUESTED')
        OR COALESCE(length(btrim("reason")), 0) > 0
    );
