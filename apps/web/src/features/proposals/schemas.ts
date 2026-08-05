import { z } from 'zod';

import { ProposalResponseType } from '@/generated/prisma/client';

// Proposal / ROS request/query contract (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-027 §1, §6). Every schema below is `.strict()` — an unrecognized
// property fails validation with `VALIDATION_ERROR` (400) rather than being
// silently stripped, matching D-027 §6's explicit "every request body is
// `.strict()`" requirement and this codebase's established
// `createBookingSchema`/`updateClientSchema` discipline. This file defines
// request/query shapes only — no repository, service, route, or database
// access exists yet (Stage 2 of this checkpoint's staged implementation).

// D-027 §1's exact content contract, reused verbatim by both
// `createProposalSchema` (a Proposal's first version) and
// `createProposalRevisionSchema` (every later revision) — every
// `ProposalVersion` this checkpoint's service layer ever creates requires
// `content`. `ProposalVersion.content`'s database-level nullability (Stage
// 1; `apps/web/prisma/schema.prisma`) exists only for safe-migration
// compatibility with a legacy row this checkpoint's own code never wrote —
// it is never reflected here as `.optional()` or `.nullable()`: every write
// this checkpoint's schemas describe requires a present, non-blank string.
// `.trim()` removes only leading/trailing whitespace; every internal
// character, including newlines, is preserved unchanged by this schema —
// trimming is the only transformation applied, never HTML sanitization,
// escaping, or markup interpretation of any kind (D-027 §1: `content` is
// always plain text, rendered as such, never executed or interpreted as
// markup by any part of this checkpoint).
const contentSchema = z
  .string()
  .trim()
  .min(1, 'content is required')
  .max(20000, 'content must be at most 20,000 characters');

// D-027 §6: `POST /api/proposals` — `{ clientId: uuid, content: string }`.
export const createProposalSchema = z
  .object({
    clientId: z.string().uuid('clientId must be a valid UUID'),
    content: contentSchema,
  })
  .strict();
export type CreateProposalInput = z.infer<typeof createProposalSchema>;

// D-027 §6: `POST /api/proposals/[id]/versions` — `{ content: string }`.
// No `clientId` field: the target Proposal (and therefore its Client) is
// already fixed by the `[id]` route param, never re-supplied in the body.
export const createProposalRevisionSchema = z
  .object({
    content: contentSchema,
  })
  .strict();
export type CreateProposalRevisionInput = z.infer<typeof createProposalRevisionSchema>;

// D-027 §5: `POST /api/proposals/versions/[id]/publish` — the caller's
// optimistic-concurrency check. `expectedCurrentVersionId` is "never
// optional or omittable" (D-027 §5) — the key itself is required on every
// request, but its *value* may be an explicit `null` (the actor observed no
// current version at all). `.nullable()` alone (never `.optional()`)
// expresses exactly that: the key must be present, and its value is either
// a UUID or `null`, never `undefined`/omitted.
export const publishProposalVersionSchema = z
  .object({
    expectedCurrentVersionId: z
      .string()
      .uuid('expectedCurrentVersionId must be a valid UUID')
      .nullable(),
  })
  .strict();
export type PublishProposalVersionInput = z.infer<typeof publishProposalVersionSchema>;

// D-027 §6/§9.1: `POST /api/proposals/versions/[id]/response` — recording
// an externally received Accept/Decline/Request Changes response. Every
// field is required — D-027 §4 requires the response type, the client's
// stated response timestamp, the response method, and a supporting
// evidence reference to always be captured together, never as a partial
// record. `responseType` is the closed `ProposalResponseType` enum
// (`apps/web/prisma/schema.prisma`) via `z.nativeEnum`, mirroring
// `updateBookingStatusSchema`'s/`listLeadsQuerySchema`'s identical
// `z.nativeEnum(...)` convention for a closed Prisma enum field.
// `respondedAt` is validated as an ISO-8601 datetime string that must carry
// timezone information — either a `Z` (UTC) suffix or a numeric UTC offset
// such as `+08:00` — via `z.iso.datetime({ offset: true })`. Confirmed
// against the installed zod@4.4.3: with `offset: true` (and `local` left at
// its default `false`), `2026-08-04T10:00:00.000Z` and
// `2026-08-04T18:00:00+08:00` both pass, while a timezone-less local
// datetime such as `2026-08-04T18:00:00` is rejected — `offset: true` adds
// acceptance of a numeric offset on top of the default's `Z`-only
// acceptance, it does not relax the requirement that some timezone marker
// be present. D-027 §6 specifies only "`respondedAt: ISO-8601 string`",
// with no restriction to UTC/`Z`-only form anywhere in the decision, and
// ISO-8601 offsets represent valid, unambiguous instants — so `offset: true`
// is used rather than the plain-`z.iso.datetime()` default, which would
// reject a client's genuinely reported local-offset response time (e.g.
// `+08:00` for Philippine time) for no reason this contract states. Unlike
// `features/clients/schemas.ts`'s `expectedUpdatedAtSchema`, this value is
// not a round-trip concurrency token that must match
// `Date.prototype.toISOString()`'s exact three-digit-millisecond output; it
// is a staff-entered historical fact (D-027 §4's "the client's stated
// response timestamp"), so no `precision` constraint is added either.
// `evidenceReference`
// remains, per D-027 §9 and .claude/rules/database-security.md's
// data-minimization principle, a bounded pointer/identifier only — this
// schema enforces only its length bound (1–500 characters); judging whether
// a given string's *content* is an appropriate pointer versus a full copy
// of correspondence is not a schema-level concern.
export const recordProposalResponseSchema = z
  .object({
    responseType: z.nativeEnum(ProposalResponseType),
    respondedAt: z.iso.datetime({ offset: true }),
    responseMethod: z
      .string()
      .trim()
      .min(1, 'responseMethod is required')
      .max(100, 'responseMethod must be at most 100 characters'),
    evidenceReference: z
      .string()
      .trim()
      .min(1, 'evidenceReference is required')
      .max(500, 'evidenceReference must be at most 500 characters'),
  })
  .strict();
export type RecordProposalResponseInput = z.infer<typeof recordProposalResponseSchema>;

// D-027 §6: `GET /api/proposals` — pagination only. No `search`, `status`,
// or `clientId` filter exists: D-027's route table names no such field for
// this endpoint, and D-027 §8 explicitly authorizes no Proposal-level
// status/title/reference field for one to filter on in the first place.
// Mirrors `listBookingsQuerySchema`'s identical page/pageSize convention.
export const listProposalsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>;

// Route-param id schemas — one per distinct resource a dynamic segment
// names, so a Proposal id and a ProposalVersion id are never structurally
// interchangeable at the type level even though both are plain UUIDs,
// matching D-027 §6's route table (`/api/proposals/[id]` names a Proposal
// id; `/api/proposals/versions/[id]` names a ProposalVersion id).
// `.strict()` here follows this checkpoint's Stage 2 instruction to apply
// it to every object schema in this file; sibling features' existing id
// param schemas (`bookingIdParamSchema`, `clientIdParamSchema`,
// `leadIdParamSchema`) do not use `.strict()` since Next.js's own router
// can never attach an extra key to a dynamic-segment params object in the
// first place — the divergence here is deliberate, not an oversight, and
// harmless: it can never reject a well-formed Next.js route call.
export const proposalIdParamSchema = z
  .object({
    id: z.string().uuid('id must be a valid UUID'),
  })
  .strict();
export type ProposalIdParam = z.infer<typeof proposalIdParamSchema>;

export const proposalVersionIdParamSchema = z
  .object({
    id: z.string().uuid('id must be a valid UUID'),
  })
  .strict();
export type ProposalVersionIdParam = z.infer<typeof proposalVersionIdParamSchema>;
