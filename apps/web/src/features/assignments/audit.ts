// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule).
export const ASSIGNMENT_AUDIT_ACTIONS = {
  LEAD_ASSIGNED: 'LEAD_ASSIGNMENT_CREATED',
  LEAD_REASSIGNED: 'LEAD_ASSIGNMENT_REPLACED',
  LEAD_ASSIGNMENT_ENDED: 'LEAD_ASSIGNMENT_ENDED',
  CLIENT_ASSIGNED: 'CLIENT_ASSIGNMENT_CREATED',
  CLIENT_REASSIGNED: 'CLIENT_ASSIGNMENT_REPLACED',
  CLIENT_ASSIGNMENT_ENDED: 'CLIENT_ASSIGNMENT_ENDED',
  // BOOKING_ASSIGNMENT_ENDED is never written by any exported function yet
  // (setBookingAssignment only — no endBookingAssignment/DELETE in this
  // checkpoint) but is still defined here for parity and because
  // service.ts's ENDED_ACTION map is typed `Record<TargetKind, string>`,
  // which requires an entry for every TargetKind including 'BOOKING'.
  BOOKING_ASSIGNED: 'BOOKING_ASSIGNMENT_CREATED',
  BOOKING_REASSIGNED: 'BOOKING_ASSIGNMENT_REPLACED',
  BOOKING_ASSIGNMENT_ENDED: 'BOOKING_ASSIGNMENT_ENDED',
} as const;

// AuditLog.entityType / entityId for an assignment change identify the
// *target* (the Lead, Client, or Booking whose assignment changed), not the
// StaffAssignment row itself — consistent with how features/staff/audit.ts
// targets the User account a staff-management action concerns.
export const ASSIGNMENT_AUDIT_ENTITY_TYPE = {
  LEAD: 'Lead',
  CLIENT: 'Client',
  BOOKING: 'Booking',
} as const;

export type AuditAssignmentSnapshot = {
  id: string;
  assignedStaffId: string;
  assignedByUserId: string;
  leadId: string | null;
  clientId: string | null;
  bookingId: string | null;
  endedAt: string | null;
};

/**
 * Builds an AuditLog before/afterState snapshot of a StaffAssignment row.
 * This is an explicit allow-list — it names exactly the seven fields it
 * reads and constructs a fresh object from them, not a spread of the
 * source record — matching features/staff/audit.ts's
 * `sanitizeAccountSnapshot` pattern. `bookingId` is included the same way
 * `leadId`/`clientId` already are: it is only the StaffAssignment row's own
 * foreign-key value (an id, not a business field), so adding it does not
 * change what this function protects against. It deliberately never reads
 * or includes any Lead/Client/Booking *business* field (name, contact
 * details, destination, notes, etc.): an assignment snapshot only ever
 * needs to say *who* held the assignment, *which* target it pointed to
 * (by id only), and *when* it ended, never the target's own data
 * (.claude/rules/database-security.md's Audit Records /
 * .claude/rules/admin-dashboard.md's Audit Trails). `createdAt`/`updatedAt`
 * are also omitted as redundant with the AuditLog row's own `createdAt`.
 * `endedAt` is serialized to an ISO string because AuditLog's
 * beforeState/afterState columns are JSON, which cannot hold a raw `Date`.
 */
export function sanitizeAssignmentSnapshot(record: {
  id: string;
  assignedStaffId: string;
  assignedByUserId: string;
  leadId: string | null;
  clientId: string | null;
  bookingId: string | null;
  endedAt: Date | null;
}): AuditAssignmentSnapshot {
  return {
    id: record.id,
    assignedStaffId: record.assignedStaffId,
    assignedByUserId: record.assignedByUserId,
    leadId: record.leadId,
    clientId: record.clientId,
    bookingId: record.bookingId,
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
  };
}
