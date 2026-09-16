import { randomUUID } from 'node:crypto';

import { canAccessClient } from '@/features/assignments/authorization';
import { findActiveAssignmentForClient } from '@/features/assignments/repository';
import { findClientProfileIdentityForUser } from '@/features/clients/repository';
import type { ConversationCategory, MessageVisibility } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';
import { prisma } from '@/lib/db';

import { ConversationError } from './errors';
import * as repository from './repository';
import type { ConversationStaffActor, NewConversationParticipant } from './repository';
import {
  conversationCategorySchema,
  messageBodySchema,
  messageVisibilitySchema,
  type ClientConversationSummary,
  type CreateConversationAsClientInput,
  type CreateConversationAsStaffInput,
  type ReplyAsClientInput,
  type ReplyAsStaffInput,
  type StaffConversationSummary,
} from './schemas';

// The conversations feature's composition-and-authorization layer (D-051
// §§3, 5, 6, 7, 15, 16, 17). Every function here independently re-derives
// and re-verifies authorization from the actor and (for a reply) a fresh
// database read — never from a caller-supplied assumption, a cached
// render-time value, or another function's already-performed check
// (D-051 §3's own explicit "no read relies on another read's already-
// performed check" discipline, mirroring D-045 §2/D-049 §2/D-050 §2).
//
// `ConversationParticipant.lastReadAt` is never read or written anywhere
// in this file, on either path, for either creation or reply — D-051 §17
// settles this definitively, not as an implementation-time judgment.

const ROLE_NOT_PERMITTED_MESSAGE =
  'This role is not permitted to perform this conversation action.';
const CONVERSATION_FORBIDDEN_MESSAGE = 'Conversation not found or not accessible.';
const VALIDATION_ERROR_MESSAGE_CATEGORY = 'category is not a recognized value.';
const VALIDATION_ERROR_MESSAGE_VISIBILITY = 'visibility is not a recognized value.';

function parseBody(raw: string): string {
  const result = messageBodySchema.safeParse(raw);
  if (!result.success) {
    throw new ConversationError(
      'VALIDATION_ERROR',
      result.error.issues[0]?.message ?? 'body is invalid.',
    );
  }
  return result.data;
}

function parseCategory(raw: unknown): ConversationCategory {
  const result = conversationCategorySchema.safeParse(raw);
  if (!result.success) {
    throw new ConversationError('VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE_CATEGORY);
  }
  return result.data;
}

function parseVisibility(raw: unknown): MessageVisibility {
  const result = messageVisibilitySchema.safeParse(raw);
  if (!result.success) {
    throw new ConversationError('VALIDATION_ERROR', VALIDATION_ERROR_MESSAGE_VISIBILITY);
  }
  return result.data;
}

/** D-051 §5/§6 — narrows to the four roles that can ever read or reply to
 * a Conversation on the staff side. CLIENT is rejected here exactly like
 * every other unrecognized role (mirroring `assertBookingActor`'s
 * identical narrowing convention, features/bookings/service.ts). */
function assertConversationStaffActor(actor: AuthenticatedUser): ConversationStaffActor {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
    case 'TRAVEL_CONSULTANT':
    case 'FINANCE_ACCOUNTING':
    case 'VISA_DOCUMENTATION':
      return { id: actor.id, role: actor.role };
    default:
      throw new ConversationError('ROLE_NOT_PERMITTED', ROLE_NOT_PERMITTED_MESSAGE);
  }
}

/** D-051 §3's own creation-time participant model: the owning Client
 * (only if a ClientProfile already exists — see
 * `repository.findClientProfileIdByClientId`'s own doc comment for the
 * graceful-degradation rule this mirrors) and, if one is currently
 * active, the assigned Travel Consultant. Never adds a FINANCE_ACCOUNTING
 * or VISA_DOCUMENTATION participant — that remains deferred (D-051 §2). */
async function resolveInitialParticipants(clientId: string): Promise<NewConversationParticipant[]> {
  const participants: NewConversationParticipant[] = [];

  const clientProfileId = await repository.findClientProfileIdByClientId(prisma, clientId);
  if (clientProfileId) {
    participants.push({ role: 'CLIENT', clientProfileId });
  }

  const activeAssignment = await findActiveAssignmentForClient(prisma, clientId);
  if (activeAssignment) {
    participants.push({ role: 'TRAVEL_CONSULTANT', staffUserId: activeAssignment.assignedStaffId });
  }

  return participants;
}

function toClientAuthorLabel(authorStaffUser: { name: string } | null): string {
  return authorStaffUser ? authorStaffUser.name : 'You';
}

function toStaffAuthorLabel(
  authorStaffUser: { name: string } | null,
  clientFullName: string,
): string {
  return authorStaffUser ? authorStaffUser.name : clientFullName;
}

// --- Client-side (D-051 §7) ---

/**
 * D-051 §3 — the owning CLIENT creates their own Conversation. `clientId`
 * is always the caller's own server-resolved owned id (Contract A,
 * `getOwnClientForUser`) — this function never resolves it itself and
 * never accepts one from a route, query, or body; the caller resolves it
 * exactly once and passes it in, mirroring every other client-portal
 * read/write in this codebase.
 */
export async function createConversationAsClient(
  actor: AuthenticatedUser,
  clientId: string,
  input: CreateConversationAsClientInput,
): Promise<void> {
  if (actor.role !== 'CLIENT') {
    throw new ConversationError('ROLE_NOT_PERMITTED', ROLE_NOT_PERMITTED_MESSAGE);
  }

  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const identity = await findClientProfileIdentityForUser(prisma, actor.id);
  if (!identity || identity.clientId !== clientId) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const category = parseCategory(input.category);
  const body = parseBody(input.body);

  const activeAssignment = await findActiveAssignmentForClient(prisma, clientId);
  const participants: NewConversationParticipant[] = [
    { role: 'CLIENT', clientProfileId: identity.clientProfileId },
  ];
  if (activeAssignment) {
    participants.push({ role: 'TRAVEL_CONSULTANT', staffUserId: activeAssignment.assignedStaffId });
  }

  await repository.createConversationWithFirstMessage(prisma, {
    id: randomUUID(),
    clientId,
    category,
    body,
    authorStaffUserId: null,
    authorClientProfileId: identity.clientProfileId,
    participants,
  });
}

/**
 * D-051 §7 — a reply from the owning CLIENT. `conversationId` is treated
 * as an untrusted, opaque targeting value (D-051 §15) — never trusted as
 * authorization by itself. Ownership (Contract A) and active
 * participation are both independently re-verified before any write; a
 * nonexistent, malformed, or unauthorized target produces the identical
 * `CONVERSATION_FORBIDDEN` outcome as every other denial reason, never
 * distinguished (D-051 §15). The write is always `CLIENT_VISIBLE` — no
 * `visibility` field exists on this input type at all (D-051 §8/§9).
 */
export async function replyAsClient(
  actor: AuthenticatedUser,
  clientId: string,
  input: ReplyAsClientInput,
): Promise<void> {
  if (actor.role !== 'CLIENT') {
    throw new ConversationError('ROLE_NOT_PERMITTED', ROLE_NOT_PERMITTED_MESSAGE);
  }

  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const identity = await findClientProfileIdentityForUser(prisma, actor.id);
  if (!identity || identity.clientId !== clientId) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const body = parseBody(input.body);

  const belongsToClient = await repository.conversationBelongsToClient(
    prisma,
    input.conversationId,
    clientId,
  );
  if (!belongsToClient) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const activeParticipant = await repository.findActiveParticipant(prisma, input.conversationId, {
    clientProfileId: identity.clientProfileId,
  });
  if (!activeParticipant) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  await repository.createMessage(prisma, {
    id: randomUUID(),
    conversationId: input.conversationId,
    body,
    visibility: 'CLIENT_VISIBLE',
    authorStaffUserId: null,
    authorClientProfileId: identity.clientProfileId,
  });
}

// D-051 §15's server-only companion to `ClientConversationSummary` —
// index-aligned with `render` (below), carrying only each Conversation's
// own `id`. Exists solely so a future `/client/support` Server Component
// (D-051 Stage 4) can closure-capture that id into its own inline reply
// Server Action, exactly mirroring `features/proposals/service.ts`'s
// identical `ClientProposalReviewServerCard`/`ClientProposalReviewServerModel`
// split for the structurally identical problem. This type is NEVER passed
// to a Client Component and NEVER included in `render` — D-051 §9's/§15's
// identifier-exposure prohibition holds by construction, since no code
// path this service exposes ever renders a `ClientConversationServerModel`
// value.
export type ClientConversationServerCard = { id: string };

export type ClientConversationServerModel = ClientConversationServerCard[];

export type ClientConversationListResult = {
  render: ClientConversationSummary[];
  serverModel: ClientConversationServerModel;
};

/**
 * D-051 §9/§15 — the client-facing Conversation list, split into two
 * index-aligned structures built from the same fetched `rows`: `render`
 * (D-051 §9's exact identifier-free allow-list — `category`, `createdAt`,
 * and each message's `body`/`createdAt`/`authorLabel` only; byte-for-byte
 * the same shape this function has always returned) and `serverModel`
 * (D-051 §15's server-only companion, carrying only each Conversation's
 * own `id`). Both are produced by their own `.map()` call over the
 * identical `rows` array, in the exact order the repository returned it —
 * `Array.prototype.map` guarantees index correspondence with its source
 * array, so `render[i]` and `serverModel[i]` always describe the same
 * Conversation; `rows` itself is never filtered, sorted, or otherwise
 * reordered between the two calls, so the two arrays cannot drift apart.
 * `INTERNAL_NOTE` messages are already excluded at the repository's own
 * query level (D-051 §8) — this function only maps the remaining domain-
 * shaped rows to their exact client-facing presentation (and, separately,
 * to the server-only companion), never re-deciding what is included.
 */
export async function listConversationsForClient(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<ClientConversationListResult> {
  if (actor.role !== 'CLIENT') {
    throw new ConversationError('ROLE_NOT_PERMITTED', ROLE_NOT_PERMITTED_MESSAGE);
  }

  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const rows = await repository.listConversationsForClient(prisma, clientId);

  const render: ClientConversationSummary[] = rows.map((row) => ({
    category: row.category,
    createdAt: row.createdAt,
    messages: row.messages.map((message) => ({
      body: message.body,
      createdAt: message.createdAt,
      authorLabel: toClientAuthorLabel(message.authorStaffUser),
    })),
  }));
  const serverModel: ClientConversationServerModel = rows.map((row) => ({ id: row.id }));

  return { render, serverModel };
}

// --- Staff-side (D-051 §3, §5, §6, §16) ---

/**
 * D-051 §3/§16 — ADMIN_MANAGER (unconditionally) or an assigned
 * TRAVEL_CONSULTANT creates a Conversation for a Client. The target
 * `clientId` is re-validated server-side against the acting staff
 * member's own authorization before any row is written — never trusted
 * merely because a request supplied it. The opening Message is always
 * `CLIENT_VISIBLE` regardless of who creates it (D-051 §16) — a staff
 * member wishing to leave a private note does so through a subsequent,
 * separate `INTERNAL_NOTE` reply (`replyAsStaff`), never through creation.
 */
export async function createConversationAsStaff(
  actor: AuthenticatedUser,
  input: CreateConversationAsStaffInput,
): Promise<void> {
  if (actor.role !== 'ADMIN_MANAGER' && actor.role !== 'TRAVEL_CONSULTANT') {
    throw new ConversationError('ROLE_NOT_PERMITTED', ROLE_NOT_PERMITTED_MESSAGE);
  }

  const access = await canAccessClient(actor, input.clientId);
  if (!access.allowed) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  const category = parseCategory(input.category);
  const body = parseBody(input.body);

  const participants = await resolveInitialParticipants(input.clientId);

  await repository.createConversationWithFirstMessage(prisma, {
    id: randomUUID(),
    clientId: input.clientId,
    category,
    body,
    authorStaffUserId: actor.id,
    authorClientProfileId: null,
    participants,
  });
}

/**
 * D-051 §15 — a reply from any staff actor already authorized for the
 * Conversation's *actual, freshly-read* owning Client — never the
 * render-time value. `conversationId` is an untrusted, opaque targeting
 * value; a nonexistent, malformed, or unauthorized target produces the
 * identical `CONVERSATION_FORBIDDEN` outcome regardless of which of the
 * three applies (D-051 §15). `visibility` is restricted to exactly
 * `CLIENT_VISIBLE`/`INTERNAL_NOTE` (D-051 §16) — both ADMIN_MANAGER and
 * TRAVEL_CONSULTANT may post either; FINANCE_ACCOUNTING/VISA_DOCUMENTATION
 * may do the same once they hold an active participant row.
 */
export async function replyAsStaff(
  actor: AuthenticatedUser,
  input: ReplyAsStaffInput,
): Promise<void> {
  const staffActor = assertConversationStaffActor(actor);
  const visibility = parseVisibility(input.visibility);
  const body = parseBody(input.body);

  const ownerClientId = await repository.findConversationOwnerClientId(
    prisma,
    input.conversationId,
  );
  if (!ownerClientId) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  let authorized = false;
  if (staffActor.role === 'ADMIN_MANAGER' || staffActor.role === 'TRAVEL_CONSULTANT') {
    const access = await canAccessClient(actor, ownerClientId);
    authorized = access.allowed;
  } else {
    const activeParticipant = await repository.findActiveParticipant(prisma, input.conversationId, {
      staffUserId: staffActor.id,
    });
    authorized = activeParticipant !== null;
  }
  if (!authorized) {
    throw new ConversationError('CONVERSATION_FORBIDDEN', CONVERSATION_FORBIDDEN_MESSAGE);
  }

  await repository.createMessage(prisma, {
    id: randomUUID(),
    conversationId: input.conversationId,
    body,
    visibility,
    authorStaffUserId: actor.id,
    authorClientProfileId: null,
  });
}

/**
 * D-051 §5/§6 — the staff-facing Conversation list, scoped to what
 * `actor` may see (`repository.listConversationsForStaff`'s own
 * `conversationVisibilityFilter`). Includes every Message regardless of
 * `visibility` — the client-facing `INTERNAL_NOTE` exclusion (D-051 §8)
 * does not apply on the staff side.
 */
export async function listConversationsForStaff(
  actor: AuthenticatedUser,
): Promise<StaffConversationSummary[]> {
  const staffActor = assertConversationStaffActor(actor);

  const rows = await repository.listConversationsForStaff(prisma, staffActor);

  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientFullName: row.client.fullName,
    category: row.category,
    createdAt: row.createdAt,
    messages: row.messages.map((message) => ({
      id: message.id,
      body: message.body,
      visibility: message.visibility,
      createdAt: message.createdAt,
      authorLabel: toStaffAuthorLabel(message.authorStaffUser, row.client.fullName),
    })),
  }));
}
