// The six roles approved in blueprint Section 4, mirrored from the Prisma
// `Role` enum (apps/web/prisma/schema.prisma) as a plain literal-string
// tuple so Better Auth's `additionalFields` config (which only understands
// its own field-type system, not Prisma enum types) can validate against
// the same set of values without importing the generated Prisma client
// into auth configuration.
export const ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
] as const;

export type AppRole = (typeof ROLES)[number];

// Staff roles are every role except CLIENT — used to gate admin-only
// surfaces once they exist (blueprint Section 4: "Client does not use the
// admin dashboard").
export const STAFF_ROLES = ROLES.filter((role) => role !== 'CLIENT') as Exclude<
  AppRole,
  'CLIENT'
>[];

export function isStaffRole(role: AppRole): boolean {
  return role !== 'CLIENT';
}
