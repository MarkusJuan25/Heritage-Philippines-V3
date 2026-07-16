-- CreateEnum
CREATE TYPE "ProposalResponseType" AS ENUM ('ACCEPT', 'DECLINE', 'REQUEST_CHANGES');

-- CreateTable
CREATE TABLE "proposal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_version" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "clientVisibleAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_acceptance" (
    "id" TEXT NOT NULL,
    "proposalVersionId" TEXT NOT NULL,
    "responseType" "ProposalResponseType" NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL,
    "respondingClientProfileId" TEXT,
    "respondingSessionIdAtResponse" TEXT,
    "recordedByStaffUserId" TEXT,
    "responseMethod" TEXT,
    "evidenceReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_acceptance_pkey" PRIMARY KEY ("id")
);

-- Hand-written: partial unique index enforcing at most one current
-- client-visible ProposalVersion per Proposal.
CREATE UNIQUE INDEX "proposal_version_current_client_visible_key"
    ON "proposal_version" ("proposalId")
    WHERE "clientVisibleAt" IS NOT NULL AND "supersededAt" IS NULL;

-- Hand-written: response-attribution-path CHECK constraint (portal xor
-- external, each path fully populated and the other fully null).
ALTER TABLE "proposal_acceptance"
ADD CONSTRAINT "proposal_acceptance_response_path"
CHECK (
    (
        "respondingClientProfileId" IS NOT NULL
        AND "respondingSessionIdAtResponse" IS NOT NULL
        AND "recordedByStaffUserId" IS NULL
        AND "responseMethod" IS NULL
        AND "evidenceReference" IS NULL
    )
    OR
    (
        "recordedByStaffUserId" IS NOT NULL
        AND "responseMethod" IS NOT NULL
        AND "evidenceReference" IS NOT NULL
        AND "respondingClientProfileId" IS NULL
        AND "respondingSessionIdAtResponse" IS NULL
    )
);

-- CreateIndex
CREATE INDEX "proposal_clientId_idx" ON "proposal"("clientId");

-- CreateIndex
CREATE INDEX "proposal_version_createdByUserId_idx" ON "proposal_version"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_version_proposalId_versionNumber_key" ON "proposal_version"("proposalId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_acceptance_proposalVersionId_key" ON "proposal_acceptance"("proposalVersionId");

-- CreateIndex
CREATE INDEX "proposal_acceptance_respondingClientProfileId_idx" ON "proposal_acceptance"("respondingClientProfileId");

-- CreateIndex
CREATE INDEX "proposal_acceptance_recordedByStaffUserId_idx" ON "proposal_acceptance"("recordedByStaffUserId");

-- CreateIndex
CREATE INDEX "proposal_acceptance_respondedAt_idx" ON "proposal_acceptance"("respondedAt");

-- AddForeignKey
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_version" ADD CONSTRAINT "proposal_version_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_version" ADD CONSTRAINT "proposal_version_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_acceptance" ADD CONSTRAINT "proposal_acceptance_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "proposal_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_acceptance" ADD CONSTRAINT "proposal_acceptance_respondingClientProfileId_fkey" FOREIGN KEY ("respondingClientProfileId") REFERENCES "client_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_acceptance" ADD CONSTRAINT "proposal_acceptance_recordedByStaffUserId_fkey" FOREIGN KEY ("recordedByStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
