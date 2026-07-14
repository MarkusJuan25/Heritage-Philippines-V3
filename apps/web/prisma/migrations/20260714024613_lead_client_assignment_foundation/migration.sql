-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'UNDER_REVIEW', 'CONTACTED', 'CONSULTATION_SCHEDULED', 'QUALIFIED', 'CONVERTED_TO_CLIENT', 'NOT_PROCEEDING', 'DUPLICATE', 'SPAM', 'ARCHIVED');

-- CreateTable
CREATE TABLE "lead" (
    "id" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "normalizedEmail" TEXT,
    "normalizedPhone" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "previousStatus" "LeadStatus",
    "newStatus" "LeadStatus" NOT NULL,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "normalizedEmail" TEXT,
    "normalizedPhone" TEXT,
    "address" TEXT,
    "nationality" TEXT,
    "dateOfBirth" DATE,
    "emergencyContact" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_assignment" (
    "id" TEXT NOT NULL,
    "assignedStaffId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "leadId" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "staff_assignment_pkey" PRIMARY KEY ("id")
);

-- Enforce exactly one assignment target
ALTER TABLE "staff_assignment"
ADD CONSTRAINT "staff_assignment_lead_xor_client"
CHECK (num_nonnulls("leadId", "clientId") = 1);

-- Allow at most one active assignment per lead
CREATE UNIQUE INDEX "staff_assignment_active_lead_key"
ON "staff_assignment" ("leadId")
WHERE "endedAt" IS NULL AND "leadId" IS NOT NULL;

-- Allow at most one active assignment per client
CREATE UNIQUE INDEX "staff_assignment_active_client_key"
ON "staff_assignment" ("clientId")
WHERE "endedAt" IS NULL AND "clientId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "lead_status_idx" ON "lead"("status");

-- CreateIndex
CREATE INDEX "lead_normalizedEmail_idx" ON "lead"("normalizedEmail");

-- CreateIndex
CREATE INDEX "lead_normalizedPhone_idx" ON "lead"("normalizedPhone");

-- CreateIndex
CREATE INDEX "lead_clientId_idx" ON "lead"("clientId");

-- CreateIndex
CREATE INDEX "lead_status_history_leadId_idx" ON "lead_status_history"("leadId");

-- CreateIndex
CREATE INDEX "lead_status_history_changedByUserId_idx" ON "lead_status_history"("changedByUserId");

-- CreateIndex
CREATE INDEX "lead_status_history_createdAt_idx" ON "lead_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "client_normalizedEmail_idx" ON "client"("normalizedEmail");

-- CreateIndex
CREATE INDEX "client_normalizedPhone_idx" ON "client"("normalizedPhone");

-- CreateIndex
CREATE INDEX "staff_assignment_assignedStaffId_endedAt_idx" ON "staff_assignment"("assignedStaffId", "endedAt");

-- CreateIndex
CREATE INDEX "staff_assignment_leadId_endedAt_idx" ON "staff_assignment"("leadId", "endedAt");

-- CreateIndex
CREATE INDEX "staff_assignment_clientId_endedAt_idx" ON "staff_assignment"("clientId", "endedAt");

-- CreateIndex
CREATE INDEX "staff_assignment_assignedByUserId_idx" ON "staff_assignment"("assignedByUserId");

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment" ADD CONSTRAINT "staff_assignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
