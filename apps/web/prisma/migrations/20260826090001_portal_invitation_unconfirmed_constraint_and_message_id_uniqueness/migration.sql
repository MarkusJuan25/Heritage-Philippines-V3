-- Portal Invitation: AUTOMATED_UNCONFIRMED constraint coverage and
-- providerMessageId uniqueness (D-034 Stage 3 implementation
-- authorization, Sections 3-4 correction).
--
-- Part 1 — extend portal_invitation_provider_states_require_automated to
-- cover the new AUTOMATED_UNCONFIRMED value added in the prior migration,
-- requiring deliveryMethod = 'AUTOMATED_EMAIL' for it exactly like every
-- other provider-side state. This is the ONLY existing constraint that
-- needs to change for the new value:
--
--   * portal_invitation_delivery_method_presence
--       CHECK (("deliveryMethod" IS NULL) = ("deliveryState" = 'NOT_ATTEMPTED'))
--     already forces deliveryMethod non-null for AUTOMATED_UNCONFIRMED
--     (it is not NOT_ATTEMPTED) — unchanged.
--   * portal_invitation_send_operation_id_presence
--       CHECK (("sendOperationId" IS NULL) = ("deliveryState" = 'NOT_ATTEMPTED'))
--     already forces sendOperationId non-null for AUTOMATED_UNCONFIRMED —
--     unchanged. This is exactly what "requires sendOperationId" means.
--   * portal_invitation_provider_message_id_automated_only
--       CHECK ("providerMessageId" IS NULL OR "deliveryMethod" IS NOT DISTINCT FROM 'AUTOMATED_EMAIL')
--     already permits providerMessageId to be null unconditionally for
--     any state — unchanged. This is exactly what "permits
--     providerMessageId to remain null" means.
--   * portal_invitation_provider_confirmed_requires_message_id
--     deliberately does NOT list AUTOMATED_UNCONFIRMED (mirroring the
--     existing PROVIDER_FAILED exclusion) — a send whose provider outcome
--     is genuinely unknown cannot be required to already have a message
--     id. Unchanged, by omission.
--
-- No CHECK constraint here can require providerMessageId to be null while
-- AUTOMATED_UNCONFIRMED (only that it MAY be) — the application/service
-- layer transitions the row out of AUTOMATED_UNCONFIRMED the moment a
-- provider message id is learned (email.sent / email.delivery_delayed
-- webhook reconciliation), so this is a service-layer invariant, not a
-- schema one; D-034 Stage 3's authorization only requires the schema to
-- "permit" null here, not forbid non-null.
ALTER TABLE "portal_invitation"
  DROP CONSTRAINT "portal_invitation_provider_states_require_automated";

ALTER TABLE "portal_invitation"
  ADD CONSTRAINT "portal_invitation_provider_states_require_automated"
  CHECK (
    "deliveryState" NOT IN ('AUTOMATED_ACCEPTED','AUTOMATED_UNCONFIRMED','PROVIDER_DELIVERED','PROVIDER_FAILED',
                             'PROVIDER_BOUNCED','PROVIDER_COMPLAINED','PROVIDER_SUPPRESSED')
    OR "deliveryMethod" = 'AUTOMATED_EMAIL'
  );

-- Part 2 — database-enforced uniqueness for a non-null providerMessageId
-- (D-034 Stage 3 implementation authorization, Section 4), so the webhook
-- handler can correlate an incoming event by providerMessageId with a
-- `findUnique`-safe lookup instead of `findFirst`. PostgreSQL unique
-- indexes already treat multiple NULLs as mutually distinct (never
-- equal), so this enforces uniqueness only across NON-null values without
-- needing a partial/WHERE-qualified index — the identical pattern this
-- table already uses for sendOperationId.
CREATE UNIQUE INDEX "portal_invitation_providerMessageId_key" ON "portal_invitation"("providerMessageId");
