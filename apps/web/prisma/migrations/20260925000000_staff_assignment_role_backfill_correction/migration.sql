-- D-054 §16 correction (September 25, 2026): data-only, no schema change.
--
-- 20260923014639_payments_staff_assignment_role backfilled every existing
-- row's `role` from its assignee's *current* `User.role`. Every row that
-- existed before that migration was created as a Travel Consultant
-- assignment, so a row whose assignee's role had since changed was given a
-- role it was never assigned under.
--
-- Rows are identified by provenance, not by timestamp. The only application
-- write path for staff_assignment is `createAssignment`, and every caller of
-- it (lead creation's self-assignment, lead-to-client conversion, and
-- setAssignment for Lead/Client/Booking) has only ever assigned a Travel
-- Consultant and, in the same transaction, written one append-only
-- audit_log row whose action is one of the six below and whose
-- `afterState.id` is the new assignment's id. A row that matches such an
-- entry was therefore created as a Travel Consultant assignment, whenever it
-- was created. A legitimate Finance/Accounting assignment can never match:
-- no Travel-Consultant-only path can create one. Rows with no matching
-- entry are left unchanged.
UPDATE "staff_assignment" AS sa
SET "role" = 'TRAVEL_CONSULTANT'
WHERE sa."role" <> 'TRAVEL_CONSULTANT'
  AND EXISTS (
    SELECT 1
    FROM "audit_log" AS al
    WHERE al."action" IN (
        'LEAD_ASSIGNMENT_CREATED',
        'LEAD_ASSIGNMENT_REPLACED',
        'CLIENT_ASSIGNMENT_CREATED',
        'CLIENT_ASSIGNMENT_REPLACED',
        'BOOKING_ASSIGNMENT_CREATED',
        'BOOKING_ASSIGNMENT_REPLACED'
      )
      AND al."afterState" ->> 'id' = sa."id"
      AND al."afterState" ->> 'assignedStaffId' = sa."assignedStaffId"
  );
