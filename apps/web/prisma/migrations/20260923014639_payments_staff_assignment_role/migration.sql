-- D-054 Stage 2 amendment (docs/HERITAGE_V3_DECISIONS_LOG.md): resolves,
-- for Booking only, the open question the StaffAssignment model's own doc
-- comment (schema.prisma) already flagged — "whether 'at most one active
-- assignment' should instead vary by an assignment type/role." Adds a
-- role snapshot column, backfills it from each row's current assignee
-- role (every row's role is always determinable this way, unlike
-- Booking.totalAmount's D-019 nullable-until-known precedent), then
-- replaces the role-agnostic active-Booking-assignment index with a
-- role-aware one. staff_assignment_active_lead_key,
-- staff_assignment_active_client_key, and
-- staff_assignment_active_visa_case_key are untouched by this migration.

-- AlterTable: add nullable first — 6 existing rows have no value yet.
ALTER TABLE "staff_assignment" ADD COLUMN "role" "Role";

-- Backfill: every existing row's role is its current assignee's role.
UPDATE "staff_assignment" AS sa
SET "role" = u."role"
FROM "user" AS u
WHERE sa."assignedStaffId" = u."id";

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "staff_assignment" ALTER COLUMN "role" SET NOT NULL;

-- Replace the role-agnostic active-Booking-assignment index with a
-- role-aware one: at most one active assignment per Booking per role.
DROP INDEX "staff_assignment_active_booking_key";

CREATE UNIQUE INDEX "staff_assignment_active_booking_role_key"
  ON "staff_assignment" ("bookingId", "role")
  WHERE "endedAt" IS NULL AND "bookingId" IS NOT NULL;
