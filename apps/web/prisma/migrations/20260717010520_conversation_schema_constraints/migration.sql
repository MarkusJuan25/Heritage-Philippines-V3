-- Conversation Schema Foundation: hand-reviewed PostgreSQL constraints that
-- Prisma's schema language cannot express, applied against the tables
-- created by migration `20260717010445_conversation_schema_foundation`.
-- See that migration's tables (conversation, conversation_participant,
-- message) and apps/web/prisma/schema.prisma's Conversation,
-- ConversationParticipant, and Message model doc comments for the full
-- rationale behind each statement below.

-- A Conversation may reference at most one related record (an optional
-- Booking or an optional Proposal, never both) in this checkpoint.
ALTER TABLE "conversation"
  ADD CONSTRAINT "conversation_related_record_exclusive"
  CHECK (num_nonnulls("relatedBookingId", "relatedProposalId") <= 1);

-- Ties ConversationParticipant.role to which identity column is populated:
-- CLIENT uses clientProfileId only; every non-CLIENT role uses staffUserId
-- only. As a direct consequence of its two mutually exclusive branches,
-- this single constraint also guarantees exactly one of
-- staffUserId/clientProfileId is non-null, so no separate num_nonnulls
-- constraint is added alongside it.
ALTER TABLE "conversation_participant"
  ADD CONSTRAINT "conversation_participant_identity_role_match"
  CHECK (
    ("role" = 'CLIENT' AND "clientProfileId" IS NOT NULL AND "staffUserId" IS NULL)
    OR
    ("role" != 'CLIENT' AND "staffUserId" IS NOT NULL AND "clientProfileId" IS NULL)
  );

-- Allow at most one active (non-removed) staff membership per person per
-- conversation, while still allowing historical removed rows and later
-- rejoining.
CREATE UNIQUE INDEX "conversation_participant_active_staff_key"
  ON "conversation_participant" ("conversationId", "staffUserId")
  WHERE "removedAt" IS NULL AND "staffUserId" IS NOT NULL;

-- Same rule for the client identity path.
CREATE UNIQUE INDEX "conversation_participant_active_client_profile_key"
  ON "conversation_participant" ("conversationId", "clientProfileId")
  WHERE "removedAt" IS NULL AND "clientProfileId" IS NOT NULL;

-- Exactly one of Message.authorStaffUserId / authorClientProfileId is
-- non-null.
ALTER TABLE "message"
  ADD CONSTRAINT "message_author_path_exclusive"
  CHECK (num_nonnulls("authorStaffUserId", "authorClientProfileId") = 1);

-- A client-authored message can never be INTERNAL_NOTE — internal staff
-- notes are by definition not something a client writes.
ALTER TABLE "message"
  ADD CONSTRAINT "message_client_author_not_internal_note"
  CHECK ("authorClientProfileId" IS NULL OR "visibility" != 'INTERNAL_NOTE');
