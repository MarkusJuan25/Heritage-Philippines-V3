-- CreateEnum
CREATE TYPE "ConversationCategory" AS ENUM ('GENERAL_INQUIRY', 'PROPOSAL_ROS', 'BOOKING', 'PAYMENT', 'DOCUMENTS', 'VISA', 'TRAVEL_PREPARATION', 'TECHNICAL_SUPPORT');

-- CreateEnum
CREATE TYPE "MessageVisibility" AS ENUM ('CLIENT_VISIBLE', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "ConversationParticipantRole" AS ENUM ('CLIENT', 'TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION');

-- CreateTable
CREATE TABLE "conversation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "category" "ConversationCategory" NOT NULL,
    "relatedBookingId" TEXT,
    "relatedProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "ConversationParticipantRole" NOT NULL,
    "staffUserId" TEXT,
    "clientProfileId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),

    CONSTRAINT "conversation_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "MessageVisibility" NOT NULL,
    "authorStaffUserId" TEXT,
    "authorClientProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_clientId_idx" ON "conversation"("clientId");

-- CreateIndex
CREATE INDEX "conversation_category_idx" ON "conversation"("category");

-- CreateIndex
CREATE INDEX "conversation_relatedBookingId_idx" ON "conversation"("relatedBookingId");

-- CreateIndex
CREATE INDEX "conversation_relatedProposalId_idx" ON "conversation"("relatedProposalId");

-- CreateIndex
CREATE INDEX "conversation_participant_conversationId_removedAt_idx" ON "conversation_participant"("conversationId", "removedAt");

-- CreateIndex
CREATE INDEX "conversation_participant_staffUserId_removedAt_idx" ON "conversation_participant"("staffUserId", "removedAt");

-- CreateIndex
CREATE INDEX "conversation_participant_clientProfileId_removedAt_idx" ON "conversation_participant"("clientProfileId", "removedAt");

-- CreateIndex
CREATE INDEX "message_conversationId_createdAt_id_idx" ON "message"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "message_authorStaffUserId_idx" ON "message"("authorStaffUserId");

-- CreateIndex
CREATE INDEX "message_authorClientProfileId_idx" ON "message"("authorClientProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachment_storageKey_key" ON "message_attachment"("storageKey");

-- CreateIndex
CREATE INDEX "message_attachment_messageId_idx" ON "message_attachment"("messageId");

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_relatedBookingId_fkey" FOREIGN KEY ("relatedBookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_relatedProposalId_fkey" FOREIGN KEY ("relatedProposalId") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "client_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_authorStaffUserId_fkey" FOREIGN KEY ("authorStaffUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_authorClientProfileId_fkey" FOREIGN KEY ("authorClientProfileId") REFERENCES "client_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
