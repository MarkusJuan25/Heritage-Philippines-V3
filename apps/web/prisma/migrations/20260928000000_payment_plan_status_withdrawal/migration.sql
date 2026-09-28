-- D-057 §2 (docs/HERITAGE_V3_DECISIONS_LOG.md), stage P2 of D-056 §7:
-- an explicit PaymentPlan lifecycle (PROPOSED, APPROVED, WITHDRAWN) so an
-- unapproved plan can be withdrawn and replaced instead of blocking its
-- Booking permanently. Forward-only, like every migration in this project.
--
-- NOT compatible with pre-P3 application code (D-057 §2): that code
-- approves a plan by setting `approvedAt` without `status`, which
-- `payment_plan_status_approval` rejects, and it reads a Booking's single
-- `paymentPlan`. No shared database (heritage_v3_test, heritage_v3_dev)
-- receives this migration except together with P3's code, following
-- D-057 §2's per-database procedure.

-- (1) The plan lifecycle.
CREATE TYPE "PaymentPlanStatus" AS ENUM ('PROPOSED', 'APPROVED', 'WITHDRAWN');

-- (2) Status (nullable until backfilled) and the withdrawal fields.
ALTER TABLE "payment_plan"
  ADD COLUMN "status" "PaymentPlanStatus",
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByStaffUserId" TEXT,
  ADD COLUMN "withdrawalReason" TEXT;

ALTER TABLE "payment_plan"
  ADD CONSTRAINT "payment_plan_withdrawnByStaffUserId_fkey"
  FOREIGN KEY ("withdrawnByStaffUserId") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "payment_plan_withdrawnByStaffUserId_idx"
  ON "payment_plan"("withdrawnByStaffUserId");

-- (3) Backfill from the existing approval gate, then require a status.
-- Every existing plan is either approved or still proposed: no withdrawal
-- mechanism existed before this migration.
UPDATE "payment_plan"
SET "status" = CASE
  WHEN "approvedAt" IS NULL THEN 'PROPOSED'::"PaymentPlanStatus"
  ELSE 'APPROVED'::"PaymentPlanStatus"
END;

ALTER TABLE "payment_plan"
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PROPOSED';

-- (4) With the existing payment_plan_approval_pairing, a plan's approval
-- and withdrawal fields can never contradict its status.
ALTER TABLE "payment_plan"
  ADD CONSTRAINT "payment_plan_status_approval"
  CHECK (("status" = 'APPROVED') = ("approvedAt" IS NOT NULL));

ALTER TABLE "payment_plan"
  ADD CONSTRAINT "payment_plan_status_withdrawal"
  CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL));

ALTER TABLE "payment_plan"
  ADD CONSTRAINT "payment_plan_withdrawal_pairing"
  CHECK (num_nonnulls("withdrawnAt", "withdrawnByStaffUserId", "withdrawalReason") IN (0, 3));

ALTER TABLE "payment_plan"
  ADD CONSTRAINT "payment_plan_withdrawal_reason_required"
  CHECK ("withdrawalReason" IS NULL OR btrim("withdrawalReason") <> '');

-- (5) Active-plan uniqueness: at most one proposed-or-approved plan per
-- Booking; any number of withdrawn plans may precede it. Migration-only —
-- Prisma cannot express a partial unique index (the same pattern as
-- installment_active_deposit_key and staff_assignment_active_booking_role_key).
DROP INDEX "payment_plan_bookingId_key";

CREATE UNIQUE INDEX "payment_plan_active_booking_key"
  ON "payment_plan"("bookingId")
  WHERE "status" <> 'WITHDRAWN';

-- (6) The plain index backing schema.prisma's `@@index([bookingId])`, which
-- replaces the dropped `@unique` for lookups that include withdrawn plans.
CREATE INDEX "payment_plan_bookingId_idx" ON "payment_plan"("bookingId");
