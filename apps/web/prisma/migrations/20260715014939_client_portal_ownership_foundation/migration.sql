-- CreateEnum
CREATE TYPE "PortalInvitationStatus" AS ENUM ('INVITATION_PREPARED', 'INVITATION_SENT', 'INVITATION_OPENED', 'ACCOUNT_ACTIVATED', 'INVITATION_EXPIRED', 'INVITATION_REVOKED');

-- CreateTable
CREATE TABLE "client_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_invitation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "PortalInvitationStatus" NOT NULL DEFAULT 'INVITATION_PREPARED',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_profile_userId_key" ON "client_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "client_profile_clientId_key" ON "client_profile"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "portal_invitation_clientId_key" ON "portal_invitation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "portal_invitation_tokenHash_key" ON "portal_invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "portal_invitation_status_idx" ON "portal_invitation"("status");

-- CreateIndex
CREATE INDEX "portal_invitation_expiresAt_idx" ON "portal_invitation"("expiresAt");

-- AddForeignKey
ALTER TABLE "client_profile" ADD CONSTRAINT "client_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_profile" ADD CONSTRAINT "client_profile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
