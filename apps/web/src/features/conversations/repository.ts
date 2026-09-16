import { randomUUID } from 'node:crypto';

import {
  type ConversationCategory,
  type MessageVisibility,
  type Prisma,
} from '@/generated/prisma/client';

// D-051 §5/§6 — the four staff roles that can ever read or reply to a
// Conversation, mirroring `bookings/repository.ts`'s identical
// `BookingActor` role-narrowing convention. CLIENT and any other role
// never reach a function accepting this type — the service layer's own
// role gate rejects them first (D-051 §3).
export type ConversationStaffActor = {
  id: string;
  role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' | 'FINANCE_ACCOUNTING' | 'VISA_DOCUMENTATION';
};

// D-051 §3 — the two participant rows every Conversation creation auto-
// adds: the owning Client always, and the currently assigned Travel
// Consultant only if one is currently active. Exactly one of
// `staffUserId`/`clientProfileId` is ever set per row, mirroring the
// database's own `conversation_participant_identity_role_match` CHECK
// constraint (schema.prisma's `ConversationParticipant` doc comment).
export type NewConversationParticipant =
  { role: 'CLIENT'; clientProfileId: string } | { role: 'TRAVEL_CONSULTANT'; staffUserId: string };

export type CreateConversationInput = {
  id: string;
  clientId: string;
  category: ConversationCategory;
  body: string;
  authorStaffUserId: string | null;
  authorClientProfileId: string | null;
  participants: NewConversationParticipant[];
};

/**
 * Creates a Conversation, its opening Message, and its initial
 * `ConversationParticipant` rows in a single Prisma nested-write — atomic
 * by construction, mirroring `proposals/repository.ts`'s
 * `createProposalWithFirstVersion` identical nested-create pattern rather
 * than a separate `$transaction` block. The opening Message is always
 * `visibility: 'CLIENT_VISIBLE'` (D-051 §3/§16) — this function accepts no
 * `visibility` parameter at all, so a caller cannot supply one.
 */
export async function createConversationWithFirstMessage(
  db: Prisma.TransactionClient,
  input: CreateConversationInput,
): Promise<{ id: string }> {
  const created = await db.conversation.create({
    data: {
      id: input.id,
      clientId: input.clientId,
      category: input.category,
      messages: {
        create: {
          id: randomUUID(),
          body: input.body,
          visibility: 'CLIENT_VISIBLE',
          authorStaffUserId: input.authorStaffUserId,
          authorClientProfileId: input.authorClientProfileId,
        },
      },
      participants: {
        create: input.participants.map((participant) => ({
          id: randomUUID(),
          role: participant.role,
          staffUserId: participant.role === 'TRAVEL_CONSULTANT' ? participant.staffUserId : null,
          clientProfileId: participant.role === 'CLIENT' ? participant.clientProfileId : null,
        })),
      },
    },
    select: { id: true },
  });
  return created;
}

export type CreateMessageInput = {
  id: string;
  conversationId: string;
  body: string;
  visibility: MessageVisibility;
  authorStaffUserId: string | null;
  authorClientProfileId: string | null;
};

/** A single reply Message — D-051 §3's "read (list + reply, which is
 * itself a Message create)"; never an update or delete. */
export async function createMessage(
  db: Prisma.TransactionClient,
  input: CreateMessageInput,
): Promise<{ id: string }> {
  return db.message.create({ data: input, select: { id: true } });
}

/**
 * The Conversation's own owning `clientId`, freshly read — never the
 * render-time/closure-captured value. D-051 §15's reply-targeting
 * mechanism requires this exact re-read on every reply, before any
 * authorization decision. `null` for a nonexistent `conversationId`; the
 * service layer maps that, indistinguishably from every other denial
 * reason, to the single generic `CONVERSATION_FORBIDDEN` outcome (D-051
 * §15) — this function itself makes no such decision.
 */
export async function findConversationOwnerClientId(
  db: Prisma.TransactionClient,
  conversationId: string,
): Promise<string | null> {
  const row = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { clientId: true },
  });
  return row?.clientId ?? null;
}

/**
 * Whether `conversationId` belongs to `clientId` — the CLIENT-side half of
 * D-051 §7's dual ownership+participation check, scoped directly in the
 * query (never "fetch and compare in code").
 */
export async function conversationBelongsToClient(
  db: Prisma.TransactionClient,
  conversationId: string,
  clientId: string,
): Promise<boolean> {
  const row = await db.conversation.findFirst({
    where: { id: conversationId, clientId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * An active (`removedAt: null`) `ConversationParticipant` row for exactly
 * one identity on one Conversation — the FINANCE_ACCOUNTING/
 * VISA_DOCUMENTATION authorization path (D-051 §5) and the CLIENT
 * participation half of D-051 §7's dual check. Never infers authorization
 * from a removed or historical row (D-051 §5's reassignment rule).
 */
export async function findActiveParticipant(
  db: Prisma.TransactionClient,
  conversationId: string,
  identity: { staffUserId: string } | { clientProfileId: string },
): Promise<{ id: string } | null> {
  return db.conversationParticipant.findFirst({
    where: {
      conversationId,
      removedAt: null,
      ...('staffUserId' in identity
        ? { staffUserId: identity.staffUserId }
        : { clientProfileId: identity.clientProfileId }),
    },
    select: { id: true },
  });
}

export type ClientConversationRow = {
  id: string;
  category: ConversationCategory;
  createdAt: Date;
  messages: Array<{
    body: string;
    createdAt: Date;
    authorStaffUser: { name: string } | null;
  }>;
};

/**
 * The client-facing Conversation list, scoped to `clientId` directly in
 * the query. `INTERNAL_NOTE` messages are excluded at this query level —
 * never fetched and filtered afterward (D-051 §8's "excluded at the data
 * layer, not the render layer" discipline). `authorStaffUser: null` means
 * the client's own message (D-051 §7 guarantees the owning Client is
 * always the sole non-staff author on their own Conversations); the
 * service layer maps that to the exact `"You"`/staff-name `authorLabel`
 * D-051 §9 requires — this repository layer returns only raw, domain-
 * shaped data, never a presentation label (.claude/rules/backend.md).
 *
 * The top-level `id` (D-051 Stage 4 client companion-model correction) is
 * the ONLY identifier this query selects — never `Message.id`, never any
 * other field beyond what D-051 §9's own client-facing allow-list already
 * required. It exists solely so the service layer can build the D-047-
 * style server-only `serverModel` a future `/client/support` Server
 * Component needs to closure-capture each Conversation's `id` into its own
 * inline reply Server Action (D-051 §15) — this repository function
 * itself makes no decision about what is safe to render; `service.ts`'s
 * own `render`/`serverModel` split is what keeps this `id` out of the
 * client-facing DTO.
 */
export async function listConversationsForClient(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<ClientConversationRow[]> {
  return db.conversation.findMany({
    where: { clientId },
    select: {
      id: true,
      category: true,
      createdAt: true,
      messages: {
        where: { visibility: 'CLIENT_VISIBLE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          body: true,
          createdAt: true,
          authorStaffUser: { select: { name: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * The target Client's own `ClientProfile.id`, if their portal account is
 * activated — needed only for the staff-initiated creation path (D-051
 * §3), where the caller has no `userId` to resolve it from the way
 * `features/clients/repository.ts`'s `findClientProfileIdentityForUser`
 * does for the client-initiated path (reused directly from that owning
 * feature in service.ts). A simple, read-only identity lookup on the
 * shared `ClientProfile` table — mirroring `bookings/repository.ts`'s own
 * established precedent of querying a related feature's table directly
 * for a plain identity/filter value (its `Client.assignments` lookup),
 * never a business-rule bypass. `null` when the Client has not yet
 * activated a portal account — D-051 §3's own "graceful degradation" for
 * a missing participant (there documented for an absent Travel
 * Consultant) applies symmetrically here: the Conversation is still
 * created, just without a CLIENT participant row until the client later
 * activates.
 */
export async function findClientProfileIdByClientId(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<string | null> {
  const row = await db.clientProfile.findUnique({ where: { clientId }, select: { id: true } });
  return row?.id ?? null;
}

export type StaffConversationRow = {
  id: string;
  clientId: string;
  client: { fullName: string };
  category: ConversationCategory;
  createdAt: Date;
  messages: Array<{
    id: string;
    body: string;
    visibility: MessageVisibility;
    createdAt: Date;
    authorStaffUser: { name: string } | null;
  }>;
};

/**
 * The staff-facing visibility filter D-051 §5/§6 defines: ADMIN_MANAGER
 * unconditional (role-wide grant, no assignment or participant row,
 * mirroring `canAccessClient`'s identical ADMIN_MANAGER branch);
 * TRAVEL_CONSULTANT scoped by an active `StaffAssignment` to the
 * Conversation's own Client (mirroring `bookings/repository.ts`'s
 * identical `clientAssignmentFilter` helper, composed directly into the
 * query — never "fetch every Conversation and filter in code",
 * .claude/rules/admin-dashboard.md's Visibility Scoping rule);
 * FINANCE_ACCOUNTING/VISA_DOCUMENTATION scoped by their own active
 * `ConversationParticipant` row, since neither role has an assignment-
 * based path onto a Client (D-051 §5).
 */
function conversationVisibilityFilter(
  actor: ConversationStaffActor,
): Prisma.ConversationWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { client: { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } } };
    case 'FINANCE_ACCOUNTING':
    case 'VISA_DOCUMENTATION':
      return { participants: { some: { staffUserId: actor.id, removedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled ConversationStaffActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * The staff-facing Conversation list, scoped to what `actor` may see per
 * `conversationVisibilityFilter` above. Includes every Message regardless
 * of `visibility` — `INTERNAL_NOTE` exclusion is a client-facing-only rule
 * (D-051 §8); staff legitimately see both in the same thread.
 */
export async function listConversationsForStaff(
  db: Prisma.TransactionClient,
  actor: ConversationStaffActor,
): Promise<StaffConversationRow[]> {
  return db.conversation.findMany({
    where: conversationVisibilityFilter(actor),
    select: {
      id: true,
      clientId: true,
      client: { select: { fullName: true } },
      category: true,
      createdAt: true,
      messages: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          body: true,
          visibility: true,
          createdAt: true,
          authorStaffUser: { select: { name: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
