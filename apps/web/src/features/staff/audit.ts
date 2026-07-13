import type { AppRole } from '@/lib/auth/roles';

// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule).
export const STAFF_AUDIT_ACTIONS = {
  ACCOUNT_CREATED: 'STAFF_ACCOUNT_CREATED',
  ROLE_CHANGED: 'STAFF_ROLE_CHANGED',
  ACCOUNT_DEACTIVATED: 'STAFF_ACCOUNT_DEACTIVATED',
  ACCOUNT_REACTIVATED: 'STAFF_ACCOUNT_REACTIVATED',
} as const;

// AuditLog.entityType for every staff-management audit entry — the target
// is always a User row.
export const STAFF_AUDIT_ENTITY_TYPE = 'User';

export type AuditAccountSnapshot = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  isActive: boolean;
};

/**
 * Builds the AuditLog.afterState snapshot for a newly created staff
 * account. This is an explicit allow-list — it names exactly the five
 * fields it reads and constructs a fresh object from them — not a spread
 * of the source record. That matters because it is the schema's own
 * documented invariant (apps/web/prisma/schema.prisma invariant #4):
 * credential creation must never write a plaintext password (or any
 * credential/session data) to AuditLog. `User` rows never carry a password
 * (that lives on `Account`, which this function never receives), so even
 * if the repository's `select` were ever widened to include more relation
 * data, this function would still only ever pick these five named fields
 * out of it — it cannot leak a field it never names.
 */
export function sanitizeAccountSnapshot(record: {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  isActive: boolean;
}): AuditAccountSnapshot {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    isActive: record.isActive,
  };
}
