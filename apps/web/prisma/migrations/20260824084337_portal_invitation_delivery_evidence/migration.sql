-- Portal Invitation Delivery Evidence (docs/HERITAGE_V3_DECISIONS_LOG.md
-- D-034 Sections 4, 6, 7, 9, 10, 13). Makes PortalInvitation.tokenHash and
-- expiresAt nullable, adds the destination-email snapshot and minimized
-- delivery-evidence fields D-034 Section 10 requires, and adds the
-- hand-written CHECK constraints Prisma's schema language cannot express.
-- Purely additive: no column, table, index, or constraint is dropped,
-- renamed, or destructively rewritten. Schema only — no repository,
-- service, route, UI, adapter, or webhook code is implemented by this
-- migration.

-- CreateEnum
CREATE TYPE "PortalInvitationDeliveryMethod" AS ENUM ('AUTOMATED_EMAIL', 'MANUAL_EMAIL');

-- CreateEnum
CREATE TYPE "PortalInvitationDeliveryState" AS ENUM ('NOT_ATTEMPTED', 'AUTOMATED_ACCEPTED', 'MANUALLY_CONFIRMED', 'PROVIDER_DELIVERED', 'PROVIDER_FAILED', 'PROVIDER_BOUNCED', 'PROVIDER_COMPLAINED', 'PROVIDER_SUPPRESSED');

-- AlterTable
ALTER TABLE "portal_invitation" ADD COLUMN     "deliveryConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryConfirmedByStaffId" TEXT,
ADD COLUMN     "deliveryMethod" "PortalInvitationDeliveryMethod",
ADD COLUMN     "deliveryState" "PortalInvitationDeliveryState" NOT NULL DEFAULT 'NOT_ATTEMPTED',
ADD COLUMN     "destinationEmail" TEXT,
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "sendOperationId" TEXT,
ALTER COLUMN "tokenHash" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "portal_invitation_sendOperationId_key" ON "portal_invitation"("sendOperationId");

-- AddForeignKey
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_deliveryConfirmedByStaffId_fkey" FOREIGN KEY ("deliveryConfirmedByStaffId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECK constraints (D-034 Stage 2 Implementation-Scope
-- Correction Pass 1, Sections 2-3). Prisma's schema language cannot
-- express any of these, mirroring this schema's existing precedent
-- (e.g. 20260717010520_conversation_schema_constraints).

-- The three token-generation fields exist, or don't exist, together —
-- always, regardless of status (D-034 Section 6: destinationEmail is
-- frozen "at the moment its token is generated").
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_token_triple_nullability"
  CHECK (
    ("tokenHash" IS NULL AND "expiresAt" IS NULL AND "destinationEmail" IS NULL)
    OR
    ("tokenHash" IS NOT NULL AND "expiresAt" IS NOT NULL AND "destinationEmail" IS NOT NULL)
  );

-- Every redeemable-or-was-redeemable status requires the non-null triple
-- (D-034 Section 13).
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_redeemable_requires_token"
  CHECK (
    "status" NOT IN ('INVITATION_SENT', 'INVITATION_OPENED', 'INVITATION_EXPIRED', 'ACCOUNT_ACTIVATED')
    OR "tokenHash" IS NOT NULL
  );

-- deliveryMethod is populated exactly when a delivery attempt has been
-- recorded.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_delivery_method_presence"
  CHECK (("deliveryMethod" IS NULL) = ("deliveryState" = 'NOT_ATTEMPTED'));

-- Provider-confirmed states require the automated channel.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_provider_states_require_automated"
  CHECK (
    "deliveryState" NOT IN ('AUTOMATED_ACCEPTED','PROVIDER_DELIVERED','PROVIDER_FAILED',
                             'PROVIDER_BOUNCED','PROVIDER_COMPLAINED','PROVIDER_SUPPRESSED')
    OR "deliveryMethod" = 'AUTOMATED_EMAIL'
  );

-- MANUALLY_CONFIRMED requires the manual channel.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_manual_confirmed_requires_manual"
  CHECK ("deliveryState" != 'MANUALLY_CONFIRMED' OR "deliveryMethod" = 'MANUAL_EMAIL');

-- providerMessageId only under the automated channel, never manual.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_provider_message_id_automated_only"
  CHECK ("providerMessageId" IS NULL OR "deliveryMethod" = 'AUTOMATED_EMAIL');

-- providerMessageId required once the provider has positively responded.
-- PROVIDER_FAILED is deliberately excluded: a send can fail before the
-- provider ever returns a message id (e.g. a request-level/network
-- failure), so providerMessageId is optional, not forbidden, for that
-- one state — left open for Stage 3 to resolve against Resend's actual
-- failure-response shape, not decided here.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_provider_confirmed_requires_message_id"
  CHECK (
    "deliveryState" NOT IN ('AUTOMATED_ACCEPTED','PROVIDER_DELIVERED','PROVIDER_BOUNCED','PROVIDER_COMPLAINED','PROVIDER_SUPPRESSED')
    OR "providerMessageId" IS NOT NULL
  );

-- Manual-confirmer identity/timestamp exist only for, and always
-- accompany, MANUALLY_CONFIRMED.
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_manual_confirmation_evidence"
  CHECK (
    ("deliveryConfirmedAt" IS NOT NULL AND "deliveryConfirmedByStaffId" IS NOT NULL AND "deliveryState" = 'MANUALLY_CONFIRMED')
    OR
    ("deliveryConfirmedAt" IS NULL AND "deliveryConfirmedByStaffId" IS NULL AND "deliveryState" != 'MANUALLY_CONFIRMED')
  );

-- sendOperationId recorded for every attempted send, regardless of
-- channel (D-034 Section 10's flat, channel-unqualified wording).
ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_send_operation_id_presence"
  CHECK (("sendOperationId" IS NULL) = ("deliveryState" = 'NOT_ATTEMPTED'));
