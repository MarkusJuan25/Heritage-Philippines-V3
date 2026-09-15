import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which eagerly validates env
// vars and opens a real database adapter at import time — mock it before
// `./service` is imported, mirroring `features/bookings/service.test.ts`'s
// identical rationale. Every repository/cross-feature call in this suite
// receives the mocked `prisma` value only as an opaque first argument
// (the mocked repository functions never actually use it), so its shape
// does not matter beyond being a stable, importable value.
vi.mock('@/lib/db', () => ({ prisma: { marker: 'prisma-singleton' } }));

const repositoryMocks = vi.hoisted(() => ({
  createConversationWithFirstMessage: vi.fn(),
  createMessage: vi.fn(),
  findConversationOwnerClientId: vi.fn(),
  conversationBelongsToClient: vi.fn(),
  findActiveParticipant: vi.fn(),
  findClientProfileIdByClientId: vi.fn(),
  listConversationsForClient: vi.fn(),
  listConversationsForStaff: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({ canAccessClient: vi.fn() }));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentsRepositoryMocks = vi.hoisted(() => ({ findActiveAssignmentForClient: vi.fn() }));
vi.mock('@/features/assignments/repository', () => assignmentsRepositoryMocks);

const clientsRepositoryMocks = vi.hoisted(() => ({ findClientProfileIdentityForUser: vi.fn() }));
vi.mock('@/features/clients/repository', () => clientsRepositoryMocks);

import type { AuthenticatedUser } from '@/lib/auth/guards';

import {
  createConversationAsClient,
  createConversationAsStaff,
  listConversationsForClient,
  listConversationsForStaff,
  replyAsClient,
  replyAsStaff,
} from './service';

const CLIENT: AuthenticatedUser = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
};
const ADMIN_MANAGER: AuthenticatedUser = {
  id: 'user-admin-1',
  email: 'admin@example.test',
  name: 'Admin One',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT: AuthenticatedUser = {
  id: 'user-tc-1',
  email: 'tc@example.test',
  name: 'Consultant One',
  role: 'TRAVEL_CONSULTANT',
};
const FINANCE_ACCOUNTING: AuthenticatedUser = {
  id: 'user-fin-1',
  email: 'fin@example.test',
  name: 'Finance One',
  role: 'FINANCE_ACCOUNTING',
};
const VISA_DOCUMENTATION: AuthenticatedUser = {
  id: 'user-visa-1',
  email: 'visa@example.test',
  name: 'Visa One',
  role: 'VISA_DOCUMENTATION',
};

const CLIENT_ID = 'client-1';
const CONVERSATION_ID = 'conversation-1';
const CLIENT_PROFILE_ID = 'profile-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createConversationAsClient', () => {
  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED before any repository or authorization call', async () => {
    await expect(
      createConversationAsClient(ADMIN_MANAGER, CLIENT_ID, {
        category: 'GENERAL_INQUIRY',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ name: 'ConversationError', code: 'ROLE_NOT_PERMITTED' });

    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(repositoryMocks.createConversationWithFirstMessage).not.toHaveBeenCalled();
  });

  it('rejects with CONVERSATION_FORBIDDEN when canAccessClient denies ownership', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      createConversationAsClient(CLIENT, CLIENT_ID, { category: 'GENERAL_INQUIRY', body: 'hi' }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });

    expect(repositoryMocks.createConversationWithFirstMessage).not.toHaveBeenCalled();
  });

  it('rejects with CONVERSATION_FORBIDDEN when the resolved ClientProfile identity does not match clientId', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: 'a-different-client',
    });

    await expect(
      createConversationAsClient(CLIENT, CLIENT_ID, { category: 'GENERAL_INQUIRY', body: 'hi' }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
  });

  it('rejects an invalid category with VALIDATION_ERROR', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: CLIENT_ID,
    });

    await expect(
      createConversationAsClient(CLIENT, CLIENT_ID, {
        category: 'NOT_A_REAL_CATEGORY' as never,
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a whitespace-only body with VALIDATION_ERROR', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: CLIENT_ID,
    });

    await expect(
      createConversationAsClient(CLIENT, CLIENT_ID, { category: 'GENERAL_INQUIRY', body: '   ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a CLIENT_VISIBLE opening Message with both Client and active Travel Consultant participants', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: CLIENT_ID,
    });
    assignmentsRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue({
      assignedStaffId: TRAVEL_CONSULTANT.id,
    });

    await createConversationAsClient(CLIENT, CLIENT_ID, {
      category: 'BOOKING',
      body: '  Question  ',
    });

    expect(repositoryMocks.createConversationWithFirstMessage).toHaveBeenCalledTimes(1);
    const input = repositoryMocks.createConversationWithFirstMessage.mock.calls[0]![1];
    expect(input.clientId).toBe(CLIENT_ID);
    expect(input.category).toBe('BOOKING');
    expect(input.body).toBe('Question');
    expect(input.authorStaffUserId).toBeNull();
    expect(input.authorClientProfileId).toBe(CLIENT_PROFILE_ID);
    expect(input.participants).toEqual([
      { role: 'CLIENT', clientProfileId: CLIENT_PROFILE_ID },
      { role: 'TRAVEL_CONSULTANT', staffUserId: TRAVEL_CONSULTANT.id },
    ]);
  });

  it('creates only the Client participant when no Travel Consultant is currently assigned', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: CLIENT_ID,
    });
    assignmentsRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await createConversationAsClient(CLIENT, CLIENT_ID, {
      category: 'GENERAL_INQUIRY',
      body: 'hi',
    });

    const input = repositoryMocks.createConversationWithFirstMessage.mock.calls[0]![1];
    expect(input.participants).toEqual([{ role: 'CLIENT', clientProfileId: CLIENT_PROFILE_ID }]);
  });
});

describe('replyAsClient', () => {
  function primeOwnership() {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: CLIENT_ID,
    });
    repositoryMocks.conversationBelongsToClient.mockResolvedValue(true);
    repositoryMocks.findActiveParticipant.mockResolvedValue({ id: 'participant-1' });
  }

  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED', async () => {
    await expect(
      replyAsClient(ADMIN_MANAGER, CLIENT_ID, { conversationId: CONVERSATION_ID, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect(repositoryMocks.createMessage).not.toHaveBeenCalled();
  });

  it('rejects with CONVERSATION_FORBIDDEN when the Conversation does not belong to this client', async () => {
    primeOwnership();
    repositoryMocks.conversationBelongsToClient.mockResolvedValue(false);

    await expect(
      replyAsClient(CLIENT, CLIENT_ID, { conversationId: CONVERSATION_ID, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
    expect(repositoryMocks.createMessage).not.toHaveBeenCalled();
  });

  it('rejects with the identical CONVERSATION_FORBIDDEN when ownership passes but no active participant row exists', async () => {
    primeOwnership();
    repositoryMocks.findActiveParticipant.mockResolvedValue(null);

    await expect(
      replyAsClient(CLIENT, CLIENT_ID, { conversationId: CONVERSATION_ID, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
  });

  it('rejects an empty body with VALIDATION_ERROR', async () => {
    primeOwnership();
    await expect(
      replyAsClient(CLIENT, CLIENT_ID, { conversationId: CONVERSATION_ID, body: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a CLIENT_VISIBLE Message authored by the client — never a caller-supplied visibility field exists on this path', async () => {
    primeOwnership();

    await replyAsClient(CLIENT, CLIENT_ID, { conversationId: CONVERSATION_ID, body: 'Thanks!' });

    expect(repositoryMocks.createMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        body: 'Thanks!',
        visibility: 'CLIENT_VISIBLE',
        authorStaffUserId: null,
        authorClientProfileId: CLIENT_PROFILE_ID,
      }),
    );
  });
});

describe('listConversationsForClient', () => {
  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED', async () => {
    await expect(listConversationsForClient(ADMIN_MANAGER, CLIENT_ID)).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    expect(repositoryMocks.listConversationsForClient).not.toHaveBeenCalled();
  });

  it('rejects with CONVERSATION_FORBIDDEN when ownership fails', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });
    await expect(listConversationsForClient(CLIENT, CLIENT_ID)).rejects.toMatchObject({
      code: 'CONVERSATION_FORBIDDEN',
    });
  });

  it('maps rows to the exact identifier-free allow-list, labeling the client author "You"', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.listConversationsForClient.mockResolvedValue([
      {
        category: 'GENERAL_INQUIRY',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        messages: [
          {
            body: 'Hi there',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            authorStaffUser: null,
          },
          {
            body: 'How can we help?',
            createdAt: new Date('2026-09-01T01:00:00.000Z'),
            authorStaffUser: { name: 'Consultant One' },
          },
        ],
      },
    ]);

    const result = await listConversationsForClient(CLIENT, CLIENT_ID);

    expect(result).toEqual([
      {
        category: 'GENERAL_INQUIRY',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        messages: [
          { body: 'Hi there', createdAt: new Date('2026-09-01T00:00:00.000Z'), authorLabel: 'You' },
          {
            body: 'How can we help?',
            createdAt: new Date('2026-09-01T01:00:00.000Z'),
            authorLabel: 'Consultant One',
          },
        ],
      },
    ]);
    // D-051 §9 — no identifier field anywhere in the composed result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(CONVERSATION_ID);
  });
});

describe('createConversationAsStaff', () => {
  it('rejects a CLIENT actor with ROLE_NOT_PERMITTED', async () => {
    await expect(
      createConversationAsStaff(CLIENT, {
        clientId: CLIENT_ID,
        category: 'GENERAL_INQUIRY',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
  });

  it('rejects FINANCE_ACCOUNTING and VISA_DOCUMENTATION with ROLE_NOT_PERMITTED — neither may create directly (D-051 §3)', async () => {
    for (const actor of [FINANCE_ACCOUNTING, VISA_DOCUMENTATION]) {
      await expect(
        createConversationAsStaff(actor, {
          clientId: CLIENT_ID,
          category: 'GENERAL_INQUIRY',
          body: 'hi',
        }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    }
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('rejects an unassigned TRAVEL_CONSULTANT with CONVERSATION_FORBIDDEN', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });
    await expect(
      createConversationAsStaff(TRAVEL_CONSULTANT, {
        clientId: CLIENT_ID,
        category: 'GENERAL_INQUIRY',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
    expect(repositoryMocks.createConversationWithFirstMessage).not.toHaveBeenCalled();
  });

  it('creates a CLIENT_VISIBLE opening Message authored by the staff actor, with both participants when both exist', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.findClientProfileIdByClientId.mockResolvedValue(CLIENT_PROFILE_ID);
    assignmentsRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue({
      assignedStaffId: TRAVEL_CONSULTANT.id,
    });

    await createConversationAsStaff(ADMIN_MANAGER, {
      clientId: CLIENT_ID,
      category: 'PAYMENT',
      body: 'Following up',
    });

    const input = repositoryMocks.createConversationWithFirstMessage.mock.calls[0]![1];
    expect(input.authorStaffUserId).toBe(ADMIN_MANAGER.id);
    expect(input.authorClientProfileId).toBeNull();
    expect(input.participants).toEqual([
      { role: 'CLIENT', clientProfileId: CLIENT_PROFILE_ID },
      { role: 'TRAVEL_CONSULTANT', staffUserId: TRAVEL_CONSULTANT.id },
    ]);
  });

  it('creates the Conversation with no Client participant when the target has no activated ClientProfile yet (D-051 §3 graceful degradation)', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.findClientProfileIdByClientId.mockResolvedValue(null);
    assignmentsRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await createConversationAsStaff(ADMIN_MANAGER, {
      clientId: CLIENT_ID,
      category: 'GENERAL_INQUIRY',
      body: 'hi',
    });

    const input = repositoryMocks.createConversationWithFirstMessage.mock.calls[0]![1];
    expect(input.participants).toEqual([]);
  });
});

describe('replyAsStaff', () => {
  it('rejects a CLIENT actor with ROLE_NOT_PERMITTED before any repository call', async () => {
    await expect(
      replyAsStaff(CLIENT, {
        conversationId: CONVERSATION_ID,
        body: 'hi',
        visibility: 'CLIENT_VISIBLE',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect(repositoryMocks.findConversationOwnerClientId).not.toHaveBeenCalled();
  });

  it('rejects an invalid visibility value with VALIDATION_ERROR', async () => {
    await expect(
      replyAsStaff(ADMIN_MANAGER, {
        conversationId: CONVERSATION_ID,
        body: 'hi',
        visibility: 'NOT_REAL' as never,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('produces the identical CONVERSATION_FORBIDDEN outcome for a nonexistent conversationId as for a real-but-unauthorized one (D-051 §15)', async () => {
    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(null);
    await expect(
      replyAsStaff(ADMIN_MANAGER, {
        conversationId: CONVERSATION_ID,
        body: 'hi',
        visibility: 'CLIENT_VISIBLE',
      }),
    ).rejects.toMatchObject({ name: 'ConversationError', code: 'CONVERSATION_FORBIDDEN' });

    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(CLIENT_ID);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });
    await expect(
      replyAsStaff(TRAVEL_CONSULTANT, {
        conversationId: CONVERSATION_ID,
        body: 'hi',
        visibility: 'CLIENT_VISIBLE',
      }),
    ).rejects.toMatchObject({ name: 'ConversationError', code: 'CONVERSATION_FORBIDDEN' });
  });

  it('re-verifies ADMIN_MANAGER/TRAVEL_CONSULTANT authorization against the freshly-read owning Client, never a caller-supplied one', async () => {
    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(CLIENT_ID);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });

    await replyAsStaff(TRAVEL_CONSULTANT, {
      conversationId: CONVERSATION_ID,
      body: 'On it',
      visibility: 'INTERNAL_NOTE',
    });

    expect(repositoryMocks.findConversationOwnerClientId).toHaveBeenCalledWith(
      expect.anything(),
      CONVERSATION_ID,
    );
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(TRAVEL_CONSULTANT, CLIENT_ID);
    expect(repositoryMocks.createMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        body: 'On it',
        visibility: 'INTERNAL_NOTE',
        authorStaffUserId: TRAVEL_CONSULTANT.id,
        authorClientProfileId: null,
      }),
    );
  });

  it('authorizes ADMIN_MANAGER unconditionally, for either visibility value', async () => {
    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(CLIENT_ID);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });

    for (const visibility of ['CLIENT_VISIBLE', 'INTERNAL_NOTE'] as const) {
      repositoryMocks.createMessage.mockClear();
      await replyAsStaff(ADMIN_MANAGER, {
        conversationId: CONVERSATION_ID,
        body: 'ok',
        visibility,
      });
      expect(repositoryMocks.createMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ visibility }),
      );
    }
  });

  it('authorizes FINANCE_ACCOUNTING/VISA_DOCUMENTATION only via an active ConversationParticipant row — never via canAccessClient', async () => {
    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(CLIENT_ID);
    repositoryMocks.findActiveParticipant.mockResolvedValue({ id: 'participant-1' });

    await replyAsStaff(FINANCE_ACCOUNTING, {
      conversationId: CONVERSATION_ID,
      body: 'Payment note',
      visibility: 'INTERNAL_NOTE',
    });

    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(repositoryMocks.findActiveParticipant).toHaveBeenCalledWith(
      expect.anything(),
      CONVERSATION_ID,
      {
        staffUserId: FINANCE_ACCOUNTING.id,
      },
    );
    expect(repositoryMocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects FINANCE_ACCOUNTING/VISA_DOCUMENTATION with no active participant row', async () => {
    repositoryMocks.findConversationOwnerClientId.mockResolvedValue(CLIENT_ID);
    repositoryMocks.findActiveParticipant.mockResolvedValue(null);

    await expect(
      replyAsStaff(VISA_DOCUMENTATION, {
        conversationId: CONVERSATION_ID,
        body: 'hi',
        visibility: 'CLIENT_VISIBLE',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
    expect(repositoryMocks.createMessage).not.toHaveBeenCalled();
  });
});

describe('listConversationsForStaff', () => {
  it('rejects a CLIENT actor with ROLE_NOT_PERMITTED', async () => {
    await expect(listConversationsForStaff(CLIENT)).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    expect(repositoryMocks.listConversationsForStaff).not.toHaveBeenCalled();
  });

  it("maps rows to the staff-facing shape, labeling a client-authored message with the Conversation's own Client name", async () => {
    repositoryMocks.listConversationsForStaff.mockResolvedValue([
      {
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        client: { fullName: 'Juan Dela Cruz' },
        category: 'BOOKING',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        messages: [
          {
            id: 'message-1',
            body: 'Hi',
            visibility: 'CLIENT_VISIBLE',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            authorStaffUser: null,
          },
          {
            id: 'message-2',
            body: 'Internal note',
            visibility: 'INTERNAL_NOTE',
            createdAt: new Date('2026-09-01T01:00:00.000Z'),
            authorStaffUser: { name: 'Consultant One' },
          },
        ],
      },
    ]);

    const result = await listConversationsForStaff(ADMIN_MANAGER);

    expect(result).toEqual([
      {
        id: CONVERSATION_ID,
        clientId: CLIENT_ID,
        clientFullName: 'Juan Dela Cruz',
        category: 'BOOKING',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        messages: [
          {
            id: 'message-1',
            body: 'Hi',
            visibility: 'CLIENT_VISIBLE',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            authorLabel: 'Juan Dela Cruz',
          },
          {
            id: 'message-2',
            body: 'Internal note',
            visibility: 'INTERNAL_NOTE',
            createdAt: new Date('2026-09-01T01:00:00.000Z'),
            authorLabel: 'Consultant One',
          },
        ],
      },
    ]);
  });
});
