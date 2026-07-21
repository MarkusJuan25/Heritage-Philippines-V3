-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionPath" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_recipientUserId_createdAt_idx" ON "notification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_recipientUserId_readAt_createdAt_idx" ON "notification"("recipientUserId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
