import { z } from 'zod';

import { STAFF_ROLES, type AppRole } from '@/lib/auth/roles';

// STAFF_ROLES is typed as a plain (non-tuple) array by roles.ts so it can
// be built with .filter(); z.enum needs a non-empty literal tuple. The
// cast is safe — roles.ts guarantees STAFF_ROLES always has exactly the
// five non-CLIENT roles.
const STAFF_ROLE_VALUES = STAFF_ROLES as unknown as [AppRole, ...AppRole[]];

// A staff account's role must be one of the five non-CLIENT roles
// (apps/web/prisma/schema.prisma invariant #3; blueprint Section 4) — this
// is the schema-level enforcement of that rule, independent of whatever a
// caller sends.
export const staffRoleSchema = z.enum(STAFF_ROLE_VALUES);

export const createStaffAccountSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  email: z.string().trim().toLowerCase().email('email must be a valid email address').max(320),
  role: staffRoleSchema,
  title: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  // Optional — the service generates a strong random password when this is
  // omitted. When provided, this is the one place a plaintext password
  // legitimately appears in a request body; it is hashed immediately and
  // never persisted or logged in plaintext (see features/staff/service.ts).
  password: z.string().min(12, 'password must be at least 12 characters').max(200).optional(),
});
export type CreateStaffAccountInput = z.infer<typeof createStaffAccountSchema>;

export const changeStaffRoleSchema = z.object({
  role: staffRoleSchema,
});
export type ChangeStaffRoleInput = z.infer<typeof changeStaffRoleSchema>;

export const deactivateStaffAccountSchema = z.object({
  // Required — admin-dashboard.md's "Destructive and Irreversible Actions"
  // rule requires irreversible/sensitive actions to be logged with a
  // reason; this feeds directly into the AuditLog entry (see
  // features/staff/service.ts).
  reason: z.string().trim().min(1, 'reason is required').max(500),
});
export type DeactivateStaffAccountInput = z.infer<typeof deactivateStaffAccountSchema>;

export const staffAccountIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// `.optional()` must be the outermost wrapper for Zod to infer `isActive`
// as a genuinely omittable object key (`isActive?: boolean`) rather than a
// required key typed `boolean | undefined` — `.optional()` placed before
// `.transform()` still parses correctly at runtime, but Zod's object-shape
// type inference only recognizes the outermost `ZodOptional` when deciding
// whether a key may be omitted from the inferred input type.
const booleanQueryParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const listStaffAccountsQuerySchema = z.object({
  role: staffRoleSchema.optional(),
  isActive: booleanQueryParam,
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListStaffAccountsQuery = z.infer<typeof listStaffAccountsQuerySchema>;
