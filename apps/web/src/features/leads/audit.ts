// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule; D-022 §7). LEAD_ASSIGNED
// (the TC creation-time self-assignment event) deliberately has no entry
// here — it reuses features/assignments/audit.ts's existing
// `ASSIGNMENT_AUDIT_ACTIONS.LEAD_ASSIGNED` ('LEAD_ASSIGNMENT_CREATED') and
// `sanitizeAssignmentSnapshot`, the exact action/sanitizer already used for
// a Lead's first-ever assignment — see service.ts's `createLead`. Adding a
// second, differently-named action for the identical event would fragment
// the audit trail rather than reuse it.
export const LEAD_AUDIT_ACTIONS = {
  LEAD_CREATED: 'LEAD_CREATED',
  LEAD_UPDATED: 'LEAD_UPDATED',
  LEAD_STATUS_CHANGED: 'LEAD_STATUS_CHANGED',
} as const;

export const LEAD_AUDIT_ENTITY_TYPE = 'Lead';

export type AuditLeadCreatedSnapshot = {
  id: string;
  status: string;
  source: string;
  hasEmail: boolean;
  hasPhone: boolean;
};

/**
 * Builds the AuditLog.afterState snapshot for a newly created Lead. An
 * explicit allow-list — it never includes `fullName`, `email`, `phone`,
 * `notes`, or a raw request body (D-022 §7's PII-free rule;
 * .claude/rules/database-security.md's Audit Records), only whether contact
 * information is present at all (`hasEmail`/`hasPhone`), matching
 * features/bookings/audit.ts's `sanitizeBookingSnapshot` allow-list
 * discipline.
 */
export function sanitizeLeadCreatedSnapshot(record: {
  id: string;
  status: string;
  source: string;
  email: string | null;
  phone: string | null;
}): AuditLeadCreatedSnapshot {
  return {
    id: record.id,
    status: record.status,
    source: record.source,
    hasEmail: Boolean(record.email),
    hasPhone: Boolean(record.phone),
  };
}

export type AuditLeadUpdateSnapshot = {
  changedFields: string[];
  hasEmail: boolean;
  hasPhone: boolean;
};

/**
 * Builds the AuditLog.afterState snapshot for an ordinary-field edit
 * (D-022 §7: "changedFields (field names only, for LEAD_UPDATED)"). Records
 * which field names changed and the resulting contact-presence state, never
 * the previous or new PII values themselves.
 */
export function sanitizeLeadUpdateSnapshot(input: {
  changedFields: readonly string[];
  hasEmail: boolean;
  hasPhone: boolean;
}): AuditLeadUpdateSnapshot {
  return {
    changedFields: [...input.changedFields],
    hasEmail: input.hasEmail,
    hasPhone: input.hasPhone,
  };
}

export type AuditLeadStatusSnapshot = { status: string; reason?: string };

/**
 * Builds the AuditLog before/afterState snapshot for a status transition
 * (D-022 §7). `reason` — the mandatory transition reason where applicable —
 * is explicitly named as safe audit metadata by D-022 §7 and is persisted
 * verbatim, mirroring features/assignments/audit.ts's existing
 * `afterState: { ...snapshot, ...(reason ? { reason } : {}) }` pattern; no
 * redaction is applied or authorized.
 */
export function sanitizeLeadStatusSnapshot(
  status: string,
  reason?: string,
): AuditLeadStatusSnapshot {
  return reason ? { status, reason } : { status };
}
