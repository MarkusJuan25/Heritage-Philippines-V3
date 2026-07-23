import { z } from 'zod';

import { LeadStatus } from '@/generated/prisma/client';

// Lead field/validation contract (docs/HERITAGE_V3_DECISIONS_LOG.md D-022
// §3). `.strict()` on both create and edit schemas rejects an unrecognized
// property outright — most importantly a caller-supplied `status`, which
// neither schema declares a field for — mirroring
// features/bookings/schemas.ts's `bookingReference` protection exactly:
// every new Lead starts NEW (service.ts), and no request can override that.

function toUndefinedIfBlank(value: string): string | undefined {
  return value === '' ? undefined : value;
}

function toNullIfBlank(value: string): string | null {
  return value === '' ? null : value;
}

const fullNameSchema = z.string().trim().min(1, 'fullName is required').max(200);
const sourceSchema = z.string().trim().min(1, 'source is required').max(200);

// Creation: a blank/omitted optional value normalizes to `undefined` (D-022
// §3's "blank optional value normalizes to null" — service.ts maps an
// absent/undefined value to `null` at the repository boundary; there is no
// existing value to distinguish "omitted" from "explicitly cleared" against
// at creation time, unlike the edit schema below).
const emailFieldSchema = z
  .string()
  .trim()
  .max(320, 'email must be at most 320 characters')
  .transform(toUndefinedIfBlank)
  .optional();
const phoneFieldSchema = z
  .string()
  .trim()
  .max(50, 'phone must be at most 50 characters')
  .transform(toUndefinedIfBlank)
  .optional();
const notesFieldSchema = z
  .string()
  .trim()
  .max(2000, 'notes must be at most 2000 characters')
  .transform(toUndefinedIfBlank)
  .optional();

export const createLeadSchema = z
  .object({
    fullName: fullNameSchema,
    source: sourceSchema,
    email: emailFieldSchema,
    phone: phoneFieldSchema,
    notes: notesFieldSchema,
  })
  .strict()
  .refine((data) => Boolean(data.email) || Boolean(data.phone), {
    message: 'At least one of email or phone is required.',
    path: ['email'],
  });
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

// Edit: every field is optional (a PATCH may touch any subset). Unlike
// creation, an existing value is always present to compare against, so a
// blank string here means "explicitly clear this field" (transformed to
// `null`, a value distinct from "omitted from the patch" — `undefined`,
// i.e. the key is simply absent from the parsed object). service.ts's
// updateLead relies on this three-way distinction (absent / null / string)
// to compute the patch's *final combined* email/phone state against the
// Lead's current values — see its own doc comment.
const patchEmailSchema = z
  .string()
  .trim()
  .max(320, 'email must be at most 320 characters')
  .transform(toNullIfBlank)
  .optional();
const patchPhoneSchema = z
  .string()
  .trim()
  .max(50, 'phone must be at most 50 characters')
  .transform(toNullIfBlank)
  .optional();
const patchNotesSchema = z
  .string()
  .trim()
  .max(2000, 'notes must be at most 2000 characters')
  .transform(toNullIfBlank)
  .optional();

export const updateLeadSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    source: sourceSchema.optional(),
    email: patchEmailSchema,
    phone: patchPhoneSchema,
    notes: patchNotesSchema,
  })
  .strict();
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const leadIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// List query (D-022 §8): pagination plus the three explicitly named
// filters — exact `status`, exact `source`, and a case-insensitive
// `search` across fullName/email/phone (features/leads/repository.ts).
// Mirrors features/staff/schemas.ts's / features/bookings/schemas.ts's
// page/pageSize convention exactly.
export const listLeadsQuerySchema = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  source: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

// Status-transition contract (D-022 §6). `reason` is optional at the schema
// level — whether it is actually required depends on the specific
// current->next transition, which Zod alone cannot know; service.ts enforces
// the conditional requirement once it has read the Lead's current status,
// mirroring features/assignments/schemas.ts's identical `setAssignmentSchema`
// discipline.
const reasonSchema = z.string().trim().min(1, 'reason is required').max(500);

export const updateLeadStatusSchema = z
  .object({
    expectedStatus: z.nativeEnum(LeadStatus),
    newStatus: z.nativeEnum(LeadStatus),
    reason: reasonSchema.optional(),
  })
  .strict();
export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;
