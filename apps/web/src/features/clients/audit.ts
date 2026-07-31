// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule; D-025 §8).
export const CLIENT_AUDIT_ACTIONS = {
  CLIENT_UPDATED: 'CLIENT_UPDATED',
} as const;

export const CLIENT_AUDIT_ENTITY_TYPE = 'Client';

export type ClientUpdateSnapshot = {
  changedFields: string[];
  hasEmail: boolean;
  hasPhone: boolean;
};

/**
 * Builds the AuditLog.afterState snapshot for an ordinary Client field edit
 * (D-025 §8) — mirrors features/leads/audit.ts's `sanitizeLeadUpdateSnapshot`
 * exactly. Records which field names changed and the resulting
 * contact-presence state, never the previous or new PII values themselves
 * (raw `fullName`, `email`, `phone`, `address`, `nationality`,
 * `dateOfBirth`, `emergencyContact`, or `notes`), and never the
 * `expectedUpdatedAt` concurrency token — that value is a comparison input,
 * not a Client field, and must never appear in an audit snapshot, matching
 * the established convention that a concurrency/transition token (e.g.
 * Lead's `expectedStatus`) never appears in its own mutation's audit
 * snapshot. `changedFields` is cloned (`[...input.changedFields]`) rather
 * than retaining the caller's array reference, so a later in-place mutation
 * of the caller's array can never retroactively alter an already-persisted
 * snapshot's in-memory representation.
 */
export function sanitizeClientUpdateSnapshot(input: {
  changedFields: readonly string[];
  hasEmail: boolean;
  hasPhone: boolean;
}): ClientUpdateSnapshot {
  return {
    changedFields: [...input.changedFields],
    hasEmail: input.hasEmail,
    hasPhone: input.hasPhone,
  };
}
