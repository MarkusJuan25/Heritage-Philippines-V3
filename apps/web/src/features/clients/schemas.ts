import { z } from 'zod';

// Client field/validation contract (docs/HERITAGE_V3_DECISIONS_LOG.md D-025
// §3/§5). `.strict()` on the PATCH schema rejects an unrecognized property
// outright — most importantly a caller-supplied `updatedAt`/`id`/anything
// else neither schema declares a field for.

function toNullIfBlank(value: string): string | null {
  return value === '' ? null : value;
}

// Edit-only feature (D-025 §1 — direct Client creation is not authorized):
// every field below is optional (a PATCH may touch any subset), and an
// existing value is always present to compare against, so a blank string
// means "explicitly clear this field" (transformed to `null`), distinct
// from "omitted from the patch" (the key is simply absent). Mirrors
// features/leads/schemas.ts's identical edit-time discipline exactly.

const fullNameSchema = z.string().trim().min(1, 'fullName is required').max(200);

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
const addressSchema = z
  .string()
  .trim()
  .max(500, 'address must be at most 500 characters')
  .transform(toNullIfBlank)
  .optional();
const nationalitySchema = z
  .string()
  .trim()
  .max(100, 'nationality must be at most 100 characters')
  .transform(toNullIfBlank)
  .optional();
const emergencyContactSchema = z
  .string()
  .trim()
  .max(200, 'emergencyContact must be at most 200 characters')
  .transform(toNullIfBlank)
  .optional();
const notesSchema = z
  .string()
  .trim()
  .max(2000, 'notes must be at most 2000 characters')
  .transform(toNullIfBlank)
  .optional();

const PHILIPPINE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * "Today" in Asia/Manila (a fixed UTC+8 offset, no DST observed) expressed
 * as a zero-padded `YYYY-MM-DD` string — D-025 §5's "current Philippine
 * business date". Computed fresh on every call (never cached), and
 * deliberately compared lexicographically against an already-validated
 * `YYYY-MM-DD` `dateOfBirth` string below, since that fixed-width format
 * sorts identically to chronological order.
 */
function currentPhilippineBusinessDate(): string {
  const manilaNow = new Date(Date.now() + PHILIPPINE_UTC_OFFSET_MS);
  const year = manilaNow.getUTCFullYear();
  const month = String(manilaNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(manilaNow.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// `z.iso.date()` (installed zod@4.4.3) validates a bare `YYYY-MM-DD` string
// against a hand-written, leap-year-aware Gregorian calendar regex — it
// already rejects an impossible day-of-month (e.g. `2026-04-31`) and an
// invalid non-leap-year February 29 (e.g. `2025-02-29`) while accepting a
// genuine leap day (e.g. `2024-02-29`), with no rollover/normalization of
// any kind, satisfying D-025 §5/§11's exact calendar-validity requirement
// without any additional hand-rolled date-arithmetic check. `null` and `''`
// are both accepted as explicit "clear this field" signals (D-025 §5); an
// omitted key preserves the Client's existing value.
//
// `.optional()` is applied *after* the transform, not before it (Stage C
// correction): with `.optional()` first, Zod parses an omitted key by
// skipping straight to `undefined` without ever invoking the transform, but
// still infers the object shape's `dateOfBirth` property as an always-present
// key whose *value* may be `undefined` — not an omittable key. Applying
// `.optional()` to the already-transformed `Date | null` schema instead makes
// the parsed object's `dateOfBirth` key itself genuinely optional
// (`dateOfBirth?: Date | null`), accurately expressing D-025's
// omitted-vs-explicit-clear contract: an omitted key is truly absent from the
// parsed object (never present with value `undefined`), and the transform
// itself only ever has to handle the union's real values (a validated date
// string, `''`, or `null`).
const dateOfBirthSchema = z
  .union([z.iso.date(), z.literal(''), z.null()])
  .transform((value, ctx): Date | null => {
    if (value === null || value === '') return null;
    if (value > currentPhilippineBusinessDate()) {
      ctx.addIssue('dateOfBirth cannot be a future date.');
      return z.NEVER;
    }
    // Persisted explicitly as UTC midnight for the Prisma/PostgreSQL
    // `@db.Date` column (D-025 §5) — never `new Date(value)` alone, so the
    // stored instant never depends on any implicit local-timezone parsing.
    return new Date(`${value}T00:00:00.000Z`);
  })
  .optional();

// Strict ISO-8601 UTC timestamp with exactly three-digit millisecond
// precision (D-025 §5/§7) — matching exactly what
// `Date.prototype.toISOString()` always produces, so the client can always
// echo back a Client's own `updatedAt` value unchanged as the next
// request's concurrency token. `offset` is left at its default (`false`),
// requiring the literal `Z` suffix `toISOString()` always emits.
const expectedUpdatedAtSchema = z.iso.datetime({ precision: 3 });

const EDITABLE_FIELD_KEYS = [
  'fullName',
  'email',
  'phone',
  'address',
  'nationality',
  'dateOfBirth',
  'emergencyContact',
  'notes',
] as const;

export const updateClientSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    email: patchEmailSchema,
    phone: patchPhoneSchema,
    address: addressSchema,
    nationality: nationalitySchema,
    dateOfBirth: dateOfBirthSchema,
    emergencyContact: emergencyContactSchema,
    notes: notesSchema,
    expectedUpdatedAt: expectedUpdatedAtSchema,
  })
  .strict()
  .refine((data) => EDITABLE_FIELD_KEYS.some((key) => Object.hasOwn(data, key)), {
    message: 'At least one editable field is required.',
  });
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const clientIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});
export type ClientIdParam = z.infer<typeof clientIdParamSchema>;

// List query (D-025 §3): pagination plus a single case-insensitive `search`
// across fullName/email/phone (features/clients/repository.ts). No
// `status` filter exists (D-025 §1/§3 — `Client.status` is not authorized)
// and no assignment filter beyond the mandatory Travel-Consultant scoping
// itself. Mirrors features/leads/schemas.ts's `listLeadsQuerySchema`
// page/pageSize convention exactly; a whitespace-only `search` value fails
// this schema's own `.min(1)` check (after trimming), producing
// `VALIDATION_ERROR` — deliberately not silently normalized to `undefined`
// here (D-025 §3).
export const listClientsQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
