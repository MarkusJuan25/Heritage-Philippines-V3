-- Constrained anonymous AuditLog actors (docs/HERITAGE_V3_DECISIONS_LOG.md
-- D-037 Section 7). Adds a USER/ANONYMOUS actor-kind discriminator and
-- makes actorId nullable so an unauthenticated, anonymous action (D-034
-- Stage 5's PORTAL_INVITATION_OPENED) can be audited without a fabricated
-- system User and without weakening the existing actor invariant for
-- every staff-attributed action, which remains USER with a required
-- actorId. Purely additive: no column, table, index, or constraint is
-- dropped, renamed, or destructively rewritten.
--
-- A read-only preflight (SELECT count(*) FROM audit_log WHERE "actorId" IS
-- NULL) was run against heritage_v3_dev immediately before this migration
-- was authored: 0 of 23 existing rows had a null actorId — every existing
-- row already satisfies the new CHECK constraint via the actorKind column
-- default below, with no data rewrite required. Adding a NOT NULL column
-- with a DEFAULT in PostgreSQL 11+ is a metadata-only operation.

-- CreateEnum
CREATE TYPE "AuditLogActorKind" AS ENUM ('USER', 'ANONYMOUS');

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "actorKind" "AuditLogActorKind" NOT NULL DEFAULT 'USER',
ALTER COLUMN "actorId" DROP NOT NULL;

-- Hand-written CHECK constraint (D-037 Section 7). Prisma's schema
-- language cannot express a cross-field conditional constraint, mirroring
-- this schema's existing precedent (e.g. PortalInvitation's token-triple
-- nullability CHECK, 20260824084337_portal_invitation_delivery_evidence).
-- Enforces both directions: a USER row always carries a non-null
-- actorId; an ANONYMOUS row never does.
ALTER TABLE "audit_log" ADD CONSTRAINT "portal_activation_audit_log_actor_kind_actor_id_consistency"
  CHECK (
    ("actorKind" = 'USER' AND "actorId" IS NOT NULL)
    OR
    ("actorKind" = 'ANONYMOUS' AND "actorId" IS NULL)
  );
