import { randomUUID } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import type { AppRole } from '@/lib/auth/roles';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same serializable
// transaction as the writes they gate (see features/assignments/service.ts)
// — none of these functions open their own transaction.
//
// The Prisma client/transaction parameter is named `db`, not `client` (the
// convention used elsewhere in this codebase, e.g.
// features/staff/repository.ts), specifically in this file: the `Client`
// Prisma model delegate (`db.client`) would otherwise collide visually with
// a parameter also named `client` (`client.client.findUnique(...)`).

export type AssignmentRecord = {
  id: string;
  assignedStaffId: string;
  assignedByUserId: string;
  leadId: string | null;
  clientId: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

const ASSIGNMENT_SELECT = {
  id: true,
  assignedStaffId: true,
  assignedByUserId: true,
  leadId: true,
  clientId: true,
  createdAt: true,
  updatedAt: true,
  endedAt: true,
} as const;

export async function findLeadById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string } | null> {
  return db.lead.findUnique({ where: { id }, select: { id: true } });
}

export async function findClientById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string } | null> {
  return db.client.findUnique({ where: { id }, select: { id: true } });
}

export type AssigneeCandidate = { id: string; role: AppRole; isActive: boolean };

// Resolves a caller-supplied assignee id to its actual account server-side,
// consistent with .claude/rules/admin-dashboard.md's "Mass Assignment and
// Unauthorized Access Protection" rule against binding a raw request body
// directly onto a database model — a caller-supplied id must be resolved
// and validated, never trusted as-is. The service layer
// (assertEligibleAssignee) decides whether the resolved candidate is
// actually eligible; this function only resolves it.
export async function findAssigneeCandidateById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<AssigneeCandidate | null> {
  return db.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true },
  });
}

/**
 * The Lead's current active assignment, if any. Scoped directly by
 * `leadId` and `endedAt: null` in the query itself — never "fetch every
 * assignment for this lead and filter in code" — per
 * .claude/rules/admin-dashboard.md's "filtered ... before rendering —
 * never filtered only ... after fetching everything" rule. The database's
 * partial unique index on (`leadId`) `WHERE endedAt IS NULL` (see the
 * StaffAssignment model's doc comment in apps/web/prisma/schema.prisma)
 * guarantees at most one row can ever match.
 */
export async function findActiveAssignmentForLead(
  db: Prisma.TransactionClient,
  leadId: string,
): Promise<AssignmentRecord | null> {
  return db.staffAssignment.findFirst({
    where: { leadId, endedAt: null },
    select: ASSIGNMENT_SELECT,
  });
}

/** The Client's current active assignment, if any — see the Lead variant above. */
export async function findActiveAssignmentForClient(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<AssignmentRecord | null> {
  return db.staffAssignment.findFirst({
    where: { clientId, endedAt: null },
    select: ASSIGNMENT_SELECT,
  });
}

export async function createAssignment(
  db: Prisma.TransactionClient,
  input: {
    id: string;
    assignedStaffId: string;
    assignedByUserId: string;
    leadId?: string;
    clientId?: string;
  },
): Promise<AssignmentRecord> {
  return db.staffAssignment.create({
    data: {
      id: input.id,
      assignedStaffId: input.assignedStaffId,
      assignedByUserId: input.assignedByUserId,
      leadId: input.leadId,
      clientId: input.clientId,
    },
    select: ASSIGNMENT_SELECT,
  });
}

// Ends an assignment by setting `endedAt` — never deletes the row, so
// assignment history is preserved (.claude/rules/database-security.md's
// referential-integrity/history rule; the StaffAssignment model's doc
// comment in apps/web/prisma/schema.prisma).
export async function endAssignmentById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<AssignmentRecord> {
  return db.staffAssignment.update({
    where: { id },
    data: { endedAt: new Date() },
    select: ASSIGNMENT_SELECT,
  });
}

export async function insertAuditLog(
  db: Prisma.TransactionClient,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeState?: Prisma.InputJsonValue;
    afterState?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      id: randomUUID(),
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
    },
  });
}
