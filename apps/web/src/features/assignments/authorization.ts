import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import * as repository from './repository';

export type ResourceAccessResult = { allowed: true } | { allowed: false; status: 403 };

/**
 * Reusable, server-side resource-authorization foundation for future Lead
 * and Client routes (Phase 2+), built on this checkpoint's StaffAssignment
 * data. blueprint Section 4 / 4.7's assignment-based access model:
 *
 * - ADMIN_MANAGER: full operational access to every Lead/Client (Section
 *   4.2).
 * - TRAVEL_CONSULTANT: allowed only when they hold the target's current
 *   *active* assignment — resolved directly from the database on every
 *   call (`findActiveAssignmentFor...`), never by fetching every
 *   assignment and filtering in application code
 *   (.claude/rules/admin-dashboard.md's "Visibility Scoping" rule). An
 *   assignment that has been ended (`endedAt` set) no longer grants access
 *   — the repository query filters on `endedAt: null`.
 * - SYSTEM_ADMINISTRATOR: no automatic operational access (blueprint
 *   Section 4.1's explicit boundary) — this platform/security role does
 *   not get Lead/Client access through this function.
 * - FINANCE_ACCOUNTING, VISA_DOCUMENTATION: no Lead/Client access through
 *   this assignment slice (their own future access model, if any, is a
 *   separate concern outside this checkpoint).
 * - CLIENT: never allowed here — this function governs *staff* operational
 *   access to a Lead/Client business record, never a client portal user's
 *   access to their own linked Client record. Client-portal ownership
 *   enforcement is explicitly deferred: it depends on the
 *   ClientProfile/User ownership link, which is not implemented yet (see
 *   apps/web/prisma/schema.prisma's file header and blueprint Section
 *   14.1). Do not use this function, or treat this checkpoint, as
 *   satisfying the client-portal-ownership half of the Phase 1
 *   "role/permission/assignment/client-ownership enforcement" checklist
 *   item — only the staff-side assignment half is covered here.
 *
 * Callers: run this *before* fetching the full Lead/Client record. This
 * function alone cannot distinguish "not authorized" from "does not
 * exist" for a Lead/Client id it has no active assignment for — that is
 * intentional, so as not to reveal resource existence to a caller who
 * isn't authorized to access it in the first place: an
 * unauthorized/unassigned caller always gets the same 403 regardless of
 * whether the id exists. Only after this check passes should a caller
 * fetch the record and return 404 if it turns out not to exist.
 */
export async function canAccessLead(
  actor: AuthenticatedUser,
  leadId: string,
): Promise<ResourceAccessResult> {
  if (actor.role === 'ADMIN_MANAGER') {
    return { allowed: true };
  }
  if (actor.role !== 'TRAVEL_CONSULTANT') {
    return { allowed: false, status: 403 };
  }

  const active = await repository.findActiveAssignmentForLead(prisma, leadId);
  if (active && active.assignedStaffId === actor.id) {
    return { allowed: true };
  }
  return { allowed: false, status: 403 };
}

/** Client counterpart of canAccessLead — see its doc comment. */
export async function canAccessClient(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<ResourceAccessResult> {
  if (actor.role === 'ADMIN_MANAGER') {
    return { allowed: true };
  }
  if (actor.role !== 'TRAVEL_CONSULTANT') {
    return { allowed: false, status: 403 };
  }

  const active = await repository.findActiveAssignmentForClient(prisma, clientId);
  if (active && active.assignedStaffId === actor.id) {
    return { allowed: true };
  }
  return { allowed: false, status: 403 };
}
