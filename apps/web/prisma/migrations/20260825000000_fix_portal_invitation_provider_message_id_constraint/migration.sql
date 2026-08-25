-- Fix portal_invitation_provider_message_id_automated_only (D-034 Stage 2
-- Correction and Integrity Review Pass 1 §5, Corrective Migration Pass 2).
--
-- The original constraint (migration 20260824084337) used a nullable-
-- operand equality:
--
--   CHECK ("providerMessageId" IS NULL OR "deliveryMethod" = 'AUTOMATED_EMAIL')
--
-- Under PostgreSQL three-valued logic, when "deliveryMethod" IS NULL (which
-- constraint portal_invitation_delivery_method_presence requires whenever
-- "deliveryState" = 'NOT_ATTEMPTED'), the equality evaluates to NULL rather
-- than TRUE or FALSE, and PostgreSQL treats a NULL CHECK result as
-- satisfied. This let a row with deliveryState = 'NOT_ATTEMPTED' (no
-- delivery attempt of any kind) carry an arbitrary non-null
-- "providerMessageId" and still pass every existing constraint —
-- confirmed empirically against a session-scoped, rolled-back temp table,
-- never against the real table.
--
-- IS NOT DISTINCT FROM is PostgreSQL's null-safe comparison operator: it
-- evaluates to a definite TRUE/FALSE even when one side is NULL, closing
-- the gap without changing behavior for any non-null "deliveryMethod".
--
-- Purely corrective and additive in effect: drops and immediately
-- re-adds the same-named constraint with a strictly narrower (never
-- looser) definition. No column, table, index, or other constraint is
-- touched. Both target databases have zero portal_invitation rows, so no
-- existing row can violate the tightened constraint.

ALTER TABLE "portal_invitation"
  DROP CONSTRAINT "portal_invitation_provider_message_id_automated_only";

ALTER TABLE "portal_invitation"
  ADD CONSTRAINT "portal_invitation_provider_message_id_automated_only"
  CHECK (
    "providerMessageId" IS NULL
    OR "deliveryMethod" IS NOT DISTINCT FROM 'AUTOMATED_EMAIL'
  );
