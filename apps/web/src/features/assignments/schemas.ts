import { z } from 'zod';

// The Lead or Client id in the route path (`/api/leads/[id]/assignment`,
// `/api/clients/[id]/assignment`). Every id in this codebase is generated
// with `randomUUID()` (see features/staff/repository.ts's
// `createStaffUser`, prisma/seed.ts) — this schema assumes the same
// convention for the Lead/Client ids a later checkpoint will generate.
export const assignmentTargetIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// Sets or replaces the active assignment for a Lead/Client. `reason` is
// intentionally optional at the schema level — the blueprint only requires
// a reason when an *existing* assignment is being replaced (never for the
// first assignment), and Zod alone cannot know whether one currently exists
// for this target. The service layer enforces the conditional requirement
// server-side (features/assignments/service.ts) once it has read that
// state.
export const setAssignmentSchema = z.object({
  assignedStaffId: z.string().uuid('assignedStaffId must be a valid UUID'),
  reason: z.string().trim().min(1, 'reason is required').max(500).optional(),
});
export type SetAssignmentInput = z.infer<typeof setAssignmentSchema>;

// Ends the active assignment for a Lead/Client. `reason` is always required
// here — .claude/rules/admin-dashboard.md's "Destructive and Irreversible
// Actions" rule requires irreversible/sensitive actions to be logged with a
// reason.
export const endAssignmentSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(500),
});
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>;
