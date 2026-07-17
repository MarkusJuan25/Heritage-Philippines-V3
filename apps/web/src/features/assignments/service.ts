import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import {
  ASSIGNMENT_AUDIT_ACTIONS,
  ASSIGNMENT_AUDIT_ENTITY_TYPE,
  sanitizeAssignmentSnapshot,
} from './audit';
import { AssignmentError } from './errors';
import * as repository from './repository';
import type { AssignmentRecord } from './repository';

function isKnownConflict(error: unknown): boolean {
  // P2034: a SERIALIZABLE conflict that survived every retry in
  // runSerializableWithRetry. P2002/P2004: the database's own partial
  // unique index / CHECK constraint on staff_assignment (see the
  // StaffAssignment model's doc comment in apps/web/prisma/schema.prisma)
  // rejecting a write that would leave more than one active assignment, or
  // both/neither of leadId and clientId set — a defense-in-depth backstop
  // in case a write ever reaches the database outside this service's own
  // "read the active assignment, then write" transaction.
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2004')
  );
}

/**
 * Runs `fn` with the shared SERIALIZABLE-retry helper
 * (@/lib/serializable-transaction), then maps any residual database
 * uniqueness/concurrency conflict to a controlled `AssignmentError` rather
 * than letting a raw Prisma/PostgreSQL error reach the route layer
 * (.claude/rules/backend.md's "Consistent Error Responses" / "No secret or
 * sensitive-error exposure").
 */
async function runAssignmentTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await runSerializableWithRetry(fn);
  } catch (error) {
    if (isKnownConflict(error)) {
      throw new AssignmentError(
        'ASSIGNMENT_CONFLICT',
        'This assignment could not be completed because of a conflicting update. Please try again.',
      );
    }
    throw error;
  }
}

/**
 * Verifies a caller-supplied assignee id resolves to an eligible Travel
 * Consultant — exists, is active, and holds exactly the TRAVEL_CONSULTANT
 * role (blueprint Section 6.4: "Each lead is assigned to a Travel
 * Consultant"). Rejects a CLIENT account, an inactive staff account, and
 * every other staff role (Admin/Manager, Finance/Accounting, Visa
 * Documentation Staff, System Administrator) — assignment as the working
 * consultant is TRAVEL_CONSULTANT-only. Only called immediately before
 * actually creating a new assignment row (see setAssignment below) — an
 * idempotent no-op retry never re-validates the already-active assignee.
 */
async function assertEligibleAssignee(
  tx: Prisma.TransactionClient,
  assignedStaffId: string,
): Promise<void> {
  const candidate = await repository.findAssigneeCandidateById(tx, assignedStaffId);
  if (!candidate) {
    throw new AssignmentError('ASSIGNEE_NOT_FOUND', 'The specified staff member was not found.');
  }
  if (!candidate.isActive) {
    throw new AssignmentError(
      'ASSIGNEE_INACTIVE',
      'The specified staff member is not active and cannot be assigned.',
    );
  }
  if (candidate.role !== 'TRAVEL_CONSULTANT') {
    throw new AssignmentError(
      'ASSIGNEE_INELIGIBLE_ROLE',
      'Only a Travel Consultant may be assigned to a lead, client, or booking.',
    );
  }
}

// 'BOOKING' assignment is independent of any Client-level assignment on the
// same Booking's Client — this module never checks or requires the
// assignee to already hold the Client assignment, and a Booking assignment
// is never ended as a side effect of the Client assignment changing (both
// deliberate; see docs/HERITAGE_V3_DECISIONS_LOG.md's Booking-assignment
// decision).
type TargetKind = 'LEAD' | 'CLIENT' | 'BOOKING';

const ENTITY_TYPE: Record<TargetKind, string> = {
  LEAD: ASSIGNMENT_AUDIT_ENTITY_TYPE.LEAD,
  CLIENT: ASSIGNMENT_AUDIT_ENTITY_TYPE.CLIENT,
  BOOKING: ASSIGNMENT_AUDIT_ENTITY_TYPE.BOOKING,
};
const ASSIGNED_ACTION: Record<TargetKind, string> = {
  LEAD: ASSIGNMENT_AUDIT_ACTIONS.LEAD_ASSIGNED,
  CLIENT: ASSIGNMENT_AUDIT_ACTIONS.CLIENT_ASSIGNED,
  BOOKING: ASSIGNMENT_AUDIT_ACTIONS.BOOKING_ASSIGNED,
};
const REASSIGNED_ACTION: Record<TargetKind, string> = {
  LEAD: ASSIGNMENT_AUDIT_ACTIONS.LEAD_REASSIGNED,
  CLIENT: ASSIGNMENT_AUDIT_ACTIONS.CLIENT_REASSIGNED,
  BOOKING: ASSIGNMENT_AUDIT_ACTIONS.BOOKING_REASSIGNED,
};
// Not exercised by any exported function in this checkpoint (no
// endBookingAssignment/DELETE) — present only so this Record stays
// complete over every TargetKind.
const ENDED_ACTION: Record<TargetKind, string> = {
  LEAD: ASSIGNMENT_AUDIT_ACTIONS.LEAD_ASSIGNMENT_ENDED,
  CLIENT: ASSIGNMENT_AUDIT_ACTIONS.CLIENT_ASSIGNMENT_ENDED,
  BOOKING: ASSIGNMENT_AUDIT_ACTIONS.BOOKING_ASSIGNMENT_ENDED,
};

async function findTarget(
  tx: Prisma.TransactionClient,
  kind: TargetKind,
  targetId: string,
): Promise<{ id: string } | null> {
  switch (kind) {
    case 'LEAD':
      return repository.findLeadById(tx, targetId);
    case 'CLIENT':
      return repository.findClientById(tx, targetId);
    case 'BOOKING':
      return repository.findBookingById(tx, targetId);
  }
}

function notFoundError(kind: TargetKind): AssignmentError {
  switch (kind) {
    case 'LEAD':
      return new AssignmentError('LEAD_NOT_FOUND', 'Lead not found.');
    case 'CLIENT':
      return new AssignmentError('CLIENT_NOT_FOUND', 'Client not found.');
    case 'BOOKING':
      return new AssignmentError('BOOKING_NOT_FOUND', 'Booking not found.');
  }
}

async function findActiveAssignment(
  tx: Prisma.TransactionClient,
  kind: TargetKind,
  targetId: string,
): Promise<AssignmentRecord | null> {
  switch (kind) {
    case 'LEAD':
      return repository.findActiveAssignmentForLead(tx, targetId);
    case 'CLIENT':
      return repository.findActiveAssignmentForClient(tx, targetId);
    case 'BOOKING':
      return repository.findActiveAssignmentForBooking(tx, targetId);
  }
}

// The target-specific field to set on a new StaffAssignment row — exactly
// one of leadId/clientId/bookingId, matching the database's three-way XOR
// CHECK constraint (apps/web/prisma/schema.prisma's StaffAssignment model).
function targetFields(
  kind: TargetKind,
  targetId: string,
): { leadId?: string; clientId?: string; bookingId?: string } {
  switch (kind) {
    case 'LEAD':
      return { leadId: targetId };
    case 'CLIENT':
      return { clientId: targetId };
    case 'BOOKING':
      return { bookingId: targetId };
  }
}

/**
 * Sets or replaces the active Travel Consultant assignment for a Lead or
 * Client (blueprint Section 6.4). Validates the target and assignee, ends
 * any existing active assignment, creates the replacement, and writes the
 * AuditLog entry — all inside one SERIALIZABLE transaction (see
 * runAssignmentTransaction), so a concurrent request can never observe a
 * target with zero or two simultaneously active assignments.
 *
 * - No existing active assignment: creates the initial assignment. `reason`
 *   is not required.
 * - An existing active assignment with the *same* assignedStaffId: a pure
 *   idempotent no-op — returns the existing row unchanged, with no new
 *   assignee-eligibility check, no database write, and no audit entry, so
 *   a caller retrying a request whose response was lost is safe.
 * - An existing active assignment with a *different* assignedStaffId:
 *   requires `reason` (REASON_REQUIRED otherwise — admin-dashboard.md's
 *   Destructive and Irreversible Actions rule), ends the previous
 *   assignment, and creates the replacement.
 */
async function setAssignment(
  kind: TargetKind,
  actor: AuthenticatedUser,
  targetId: string,
  assignedStaffId: string,
  reason: string | undefined,
): Promise<AssignmentRecord> {
  return runAssignmentTransaction(async (tx) => {
    const target = await findTarget(tx, kind, targetId);
    if (!target) {
      throw notFoundError(kind);
    }

    const active = await findActiveAssignment(tx, kind, targetId);

    if (active && active.assignedStaffId === assignedStaffId) {
      return active;
    }

    // About to actually create a new assignment row (initial or
    // replacement) — validate the assignee now, not before the idempotent
    // no-op check above.
    await assertEligibleAssignee(tx, assignedStaffId);

    if (active && !reason) {
      throw new AssignmentError(
        'REASON_REQUIRED',
        'A reason is required when replacing an existing assignment.',
      );
    }

    if (active) {
      await repository.endAssignmentById(tx, active.id);
    }

    const created = await repository.createAssignment(tx, {
      id: randomUUID(),
      assignedStaffId,
      assignedByUserId: actor.id,
      ...targetFields(kind, targetId),
    });

    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: active ? REASSIGNED_ACTION[kind] : ASSIGNED_ACTION[kind],
      entityType: ENTITY_TYPE[kind],
      entityId: targetId,
      beforeState: active ? sanitizeAssignmentSnapshot(active) : undefined,
      afterState: { ...sanitizeAssignmentSnapshot(created), ...(reason ? { reason } : {}) },
    });

    return created;
  });
}

/**
 * Ends the active assignment for a Lead or Client, preserving it as history
 * (`endedAt` set, row never deleted). Idempotent: retrying an end request
 * when nothing is currently active is a no-op — no database write and no
 * duplicate audit entry — and returns `null` to signal "no active
 * assignment remains" either way.
 */
async function endAssignment(
  kind: TargetKind,
  actor: AuthenticatedUser,
  targetId: string,
  reason: string,
): Promise<AssignmentRecord | null> {
  return runAssignmentTransaction(async (tx) => {
    const target = await findTarget(tx, kind, targetId);
    if (!target) {
      throw notFoundError(kind);
    }

    const active = await findActiveAssignment(tx, kind, targetId);
    if (!active) {
      return null;
    }

    const ended = await repository.endAssignmentById(tx, active.id);

    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: ENDED_ACTION[kind],
      entityType: ENTITY_TYPE[kind],
      entityId: targetId,
      beforeState: sanitizeAssignmentSnapshot(active),
      afterState: { ...sanitizeAssignmentSnapshot(ended), reason },
    });

    return ended;
  });
}

export async function setLeadAssignment(
  actor: AuthenticatedUser,
  leadId: string,
  assignedStaffId: string,
  reason?: string,
): Promise<AssignmentRecord> {
  return setAssignment('LEAD', actor, leadId, assignedStaffId, reason);
}

export async function endLeadAssignment(
  actor: AuthenticatedUser,
  leadId: string,
  reason: string,
): Promise<AssignmentRecord | null> {
  return endAssignment('LEAD', actor, leadId, reason);
}

export async function setClientAssignment(
  actor: AuthenticatedUser,
  clientId: string,
  assignedStaffId: string,
  reason?: string,
): Promise<AssignmentRecord> {
  return setAssignment('CLIENT', actor, clientId, assignedStaffId, reason);
}

export async function endClientAssignment(
  actor: AuthenticatedUser,
  clientId: string,
  reason: string,
): Promise<AssignmentRecord | null> {
  return endAssignment('CLIENT', actor, clientId, reason);
}

// No endBookingAssignment export — assignment removal without a
// replacement is out of scope for this checkpoint (Booking assignment
// enforcement decision). setAssignment's own control flow (idempotent
// same-assignee no-op, REASON_REQUIRED on replace, atomic
// end-old/create-new/audit) is reused unchanged for 'BOOKING'.
export async function setBookingAssignment(
  actor: AuthenticatedUser,
  bookingId: string,
  assignedStaffId: string,
  reason?: string,
): Promise<AssignmentRecord> {
  return setAssignment('BOOKING', actor, bookingId, assignedStaffId, reason);
}
