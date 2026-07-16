// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule). Only booking *creation* is
// audited in this checkpoint — no status-transition or update actions exist
// yet to name.
export const BOOKING_AUDIT_ACTIONS = {
  BOOKING_CREATED: 'BOOKING_CREATED',
} as const;

// AuditLog.entityType for every booking-management audit entry — the
// target is always a Booking row.
export const BOOKING_AUDIT_ENTITY_TYPE = 'Booking';

export type AuditBookingSnapshot = {
  id: string;
  bookingReference: string;
  clientId: string;
  proposalVersionId: string;
  status: string;
};

/**
 * Builds the AuditLog.afterState snapshot for a newly created Booking. This
 * is an explicit allow-list — it names exactly the five fields it reads and
 * constructs a fresh object from them, not a spread of the source record —
 * matching features/assignments/audit.ts's `sanitizeAssignmentSnapshot` and
 * features/staff/audit.ts's `sanitizeAccountSnapshot`. It deliberately never
 * includes travel details, service/notes free-text fields, or any
 * ProposalVersion/Client field: an audit snapshot only ever needs to say
 * *which* booking was created, for *which* client and proposal version, and
 * in what status — never the surrounding business content
 * (.claude/rules/database-security.md's Audit Records /
 * .claude/rules/admin-dashboard.md's Audit Trails).
 */
export function sanitizeBookingSnapshot(record: {
  id: string;
  bookingReference: string;
  clientId: string;
  proposalVersionId: string;
  status: string;
}): AuditBookingSnapshot {
  return {
    id: record.id,
    bookingReference: record.bookingReference,
    clientId: record.clientId,
    proposalVersionId: record.proposalVersionId,
    status: record.status,
  };
}
