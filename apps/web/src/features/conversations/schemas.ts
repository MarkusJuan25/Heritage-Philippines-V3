import { z } from 'zod';

import { ConversationCategory, MessageVisibility } from '@/generated/prisma/client';

import { MESSAGE_BODY_MAX_LENGTH } from './constants';

// Re-exported for every existing import site (e.g. `schemas.test.ts`) —
// the value itself lives solely in `./constants.ts`, a dependency-free
// module a `'use client'` component can import directly without pulling
// in this file's own runtime value-import of `@/generated/prisma/client`
// below (see `constants.ts`'s doc comment for the full rationale).
export { MESSAGE_BODY_MAX_LENGTH };

// D-051 §16's message-body validation: required non-whitespace content,
// mirroring D-027 §1's `contentSchema` "content is required" non-empty
// rule (features/proposals/schemas.ts). D-051 §16 confirms no established
// maximum exists anywhere in this repository for a chat-style message
// specifically (unlike `ProposalVersion.content`'s own, differently-scoped
// 20,000-character ceiling, and unlike `schema.prisma:2443`'s own
// unconstrained `String`/Postgres `TEXT` `Message.body` column, which
// carries no database-level length limit either) — but §16 does not leave
// the *presence* of a ceiling open: it expressly requires "Stage 2's own
// implementation must set one... following D-027's own established
// mechanism (a Zod service-layer `.max()` ceiling, never a bare,
// unvalidated `String`)," with only "its exact figure a Stage 2
// implementation-time decision this entry does not fix." The 5,000-
// character figure (`./constants.ts`) is that authorized Stage 2
// implementation-time decision — it is NOT claimed to be a pre-existing
// repository or database limit, and no such limit exists; D-051 §16
// itself both requires and authorizes Stage 2 to choose it. Non-empty-
// after-trim validation is preserved in full, applied before the ceiling.
export const messageBodySchema = z
  .string()
  .trim()
  .min(1, 'body is required')
  .max(MESSAGE_BODY_MAX_LENGTH, `body must be at most ${MESSAGE_BODY_MAX_LENGTH} characters`);

// D-051 §4 — the closed, already-migrated eight-value enum, reused
// unmodified. No Phase-3-only subset (D-051 §4 declines to invent one).
export const conversationCategorySchema = z.nativeEnum(ConversationCategory);

// D-051 §16 — accepted only on a staff reply path; a CLIENT actor is never
// offered this field at all (D-051 §8/§9), regardless of what a tampered
// request might supply.
export const messageVisibilitySchema = z.nativeEnum(MessageVisibility);

export type CreateConversationAsClientInput = {
  category: ConversationCategory;
  body: string;
};

export type CreateConversationAsStaffInput = {
  clientId: string;
  category: ConversationCategory;
  body: string;
};

export type ReplyAsClientInput = {
  conversationId: string;
  body: string;
};

export type ReplyAsStaffInput = {
  conversationId: string;
  body: string;
  visibility: MessageVisibility;
};

// D-051 §9 — the exact, identifier-free client-facing allow-list. No
// `Conversation.id`, `Client.id`, `ClientProfile.id`, `User.id`, related-
// record id, `ConversationParticipant`/`lastReadAt`, `INTERNAL_NOTE`
// message, or `MessageAttachment` field is ever present. `authorLabel` is
// the staff author's real name (D-040 §7's `ConsultantCard` disclosure
// precedent) or `"You"` for the client's own messages — never a raw id.
export type ClientConversationMessage = {
  body: string;
  createdAt: Date;
  authorLabel: string;
};

export type ClientConversationSummary = {
  category: ConversationCategory;
  createdAt: Date;
  messages: ClientConversationMessage[];
};

// Staff-facing shapes retain internal identifiers — D-051 places no
// identifier-minimization requirement on the staff side, and staff
// already sees database ids throughout the existing admin dashboard.
// `authorLabel` is the staff author's real name, or the Conversation's own
// Client's `fullName` for a client-authored message (a Conversation has
// exactly one Client, so no per-message client lookup is needed).
export type StaffConversationMessage = {
  id: string;
  body: string;
  visibility: MessageVisibility;
  createdAt: Date;
  authorLabel: string;
};

export type StaffConversationSummary = {
  id: string;
  clientId: string;
  clientFullName: string;
  category: ConversationCategory;
  createdAt: Date;
  messages: StaffConversationMessage[];
};
