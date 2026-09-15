import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  conversationBelongsToClient,
  createConversationWithFirstMessage,
  createMessage,
  findActiveParticipant,
  findClientProfileIdByClientId,
  findConversationOwnerClientId,
  listConversationsForClient,
  listConversationsForStaff,
} from './repository';

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };
const FINANCE_ACCOUNTING = { id: 'fin-1', role: 'FINANCE_ACCOUNTING' as const };
const VISA_DOCUMENTATION = { id: 'visa-1', role: 'VISA_DOCUMENTATION' as const };

const CLIENT_ID = 'client-1';
const CONVERSATION_ID = 'conversation-1';

describe('createConversationWithFirstMessage', () => {
  it('nests the opening Message (always CLIENT_VISIBLE) and every participant in one create call', async () => {
    const create = vi.fn().mockResolvedValue({ id: CONVERSATION_ID });
    const db = { conversation: { create } } as unknown as Prisma.TransactionClient;

    await createConversationWithFirstMessage(db, {
      id: CONVERSATION_ID,
      clientId: CLIENT_ID,
      category: 'GENERAL_INQUIRY',
      body: 'Hello',
      authorStaffUserId: null,
      authorClientProfileId: 'profile-1',
      participants: [
        { role: 'CLIENT', clientProfileId: 'profile-1' },
        { role: 'TRAVEL_CONSULTANT', staffUserId: TRAVEL_CONSULTANT.id },
      ],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]![0];
    expect(call.data.id).toBe(CONVERSATION_ID);
    expect(call.data.clientId).toBe(CLIENT_ID);
    expect(call.data.category).toBe('GENERAL_INQUIRY');
    expect(call.data.messages.create).toMatchObject({
      body: 'Hello',
      visibility: 'CLIENT_VISIBLE',
      authorStaffUserId: null,
      authorClientProfileId: 'profile-1',
    });
    expect(call.data.participants.create).toEqual([
      { id: expect.any(String), role: 'CLIENT', staffUserId: null, clientProfileId: 'profile-1' },
      {
        id: expect.any(String),
        role: 'TRAVEL_CONSULTANT',
        staffUserId: TRAVEL_CONSULTANT.id,
        clientProfileId: null,
      },
    ]);
  });

  it('creates only the Client participant when no Travel Consultant is currently assigned', async () => {
    const create = vi.fn().mockResolvedValue({ id: CONVERSATION_ID });
    const db = { conversation: { create } } as unknown as Prisma.TransactionClient;

    await createConversationWithFirstMessage(db, {
      id: CONVERSATION_ID,
      clientId: CLIENT_ID,
      category: 'GENERAL_INQUIRY',
      body: 'Hello',
      authorStaffUserId: null,
      authorClientProfileId: 'profile-1',
      participants: [{ role: 'CLIENT', clientProfileId: 'profile-1' }],
    });

    const call = create.mock.calls[0]![0];
    expect(call.data.participants.create).toHaveLength(1);
  });
});

describe('createMessage', () => {
  it('passes the input straight through as the Message create data', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'message-1' });
    const db = { message: { create } } as unknown as Prisma.TransactionClient;

    const input = {
      id: 'message-1',
      conversationId: CONVERSATION_ID,
      body: 'A reply',
      visibility: 'INTERNAL_NOTE' as const,
      authorStaffUserId: 'staff-1',
      authorClientProfileId: null,
    };
    await createMessage(db, input);

    expect(create).toHaveBeenCalledWith({ data: input, select: { id: true } });
  });
});

describe('findConversationOwnerClientId', () => {
  it('returns the owning clientId when the Conversation exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({ clientId: CLIENT_ID });
    const db = { conversation: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findConversationOwnerClientId(db, CONVERSATION_ID);

    expect(result).toBe(CLIENT_ID);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      select: { clientId: true },
    });
  });

  it('returns null for a nonexistent Conversation', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { conversation: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findConversationOwnerClientId(db, CONVERSATION_ID)).toBeNull();
  });
});

describe('conversationBelongsToClient', () => {
  it('scopes the query by both id and clientId together', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: CONVERSATION_ID });
    const db = { conversation: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await conversationBelongsToClient(db, CONVERSATION_ID, CLIENT_ID);

    expect(result).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, clientId: CLIENT_ID },
      select: { id: true },
    });
  });

  it('returns false when no matching row is found', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { conversation: { findFirst } } as unknown as Prisma.TransactionClient;

    expect(await conversationBelongsToClient(db, CONVERSATION_ID, CLIENT_ID)).toBe(false);
  });
});

describe('findActiveParticipant', () => {
  it('scopes by staffUserId and removedAt: null when given a staff identity', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'participant-1' });
    const db = { conversationParticipant: { findFirst } } as unknown as Prisma.TransactionClient;

    await findActiveParticipant(db, CONVERSATION_ID, { staffUserId: 'staff-1' });

    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID, removedAt: null, staffUserId: 'staff-1' },
      select: { id: true },
    });
  });

  it('scopes by clientProfileId and removedAt: null when given a client identity', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { conversationParticipant: { findFirst } } as unknown as Prisma.TransactionClient;

    await findActiveParticipant(db, CONVERSATION_ID, { clientProfileId: 'profile-1' });

    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID, removedAt: null, clientProfileId: 'profile-1' },
      select: { id: true },
    });
  });
});

describe('findClientProfileIdByClientId', () => {
  it('looks up ClientProfile by the unique clientId column', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'profile-1' });
    const db = { clientProfile: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientProfileIdByClientId(db, CLIENT_ID);

    expect(result).toBe('profile-1');
    expect(findUnique).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID },
      select: { id: true },
    });
  });

  it('returns null when the Client has no activated ClientProfile yet', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { clientProfile: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findClientProfileIdByClientId(db, CLIENT_ID)).toBeNull();
  });
});

describe('listConversationsForClient', () => {
  it('scopes by clientId and filters nested messages to CLIENT_VISIBLE only', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForClient(db, CLIENT_ID);

    const call = findMany.mock.calls[0]![0];
    expect(call.where).toEqual({ clientId: CLIENT_ID });
    expect(call.select.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
    // D-051 §9 — no identifier field selected anywhere in this query shape.
    expect(call.select).not.toHaveProperty('id');
    expect(call.select.messages.select).not.toHaveProperty('id');
    expect(call.select.messages.select).not.toHaveProperty('authorClientProfileId');
  });
});

describe('listConversationsForStaff — role-scoped visibility filter', () => {
  it('applies no Client filter for ADMIN_MANAGER (unconditional access)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForStaff(db, ADMIN_MANAGER);

    expect(findMany.mock.calls[0]![0].where).toBeUndefined();
  });

  it('scopes by active StaffAssignment via the Client relation for TRAVEL_CONSULTANT', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForStaff(db, TRAVEL_CONSULTANT);

    expect(findMany.mock.calls[0]![0].where).toEqual({
      client: { assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } } },
    });
  });

  it('scopes by an active ConversationParticipant row for FINANCE_ACCOUNTING', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForStaff(db, FINANCE_ACCOUNTING);

    expect(findMany.mock.calls[0]![0].where).toEqual({
      participants: { some: { staffUserId: FINANCE_ACCOUNTING.id, removedAt: null } },
    });
  });

  it('scopes by an active ConversationParticipant row for VISA_DOCUMENTATION', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForStaff(db, VISA_DOCUMENTATION);

    expect(findMany.mock.calls[0]![0].where).toEqual({
      participants: { some: { staffUserId: VISA_DOCUMENTATION.id, removedAt: null } },
    });
  });

  it('includes every message regardless of visibility (no CLIENT_VISIBLE filter on the staff side)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { conversation: { findMany } } as unknown as Prisma.TransactionClient;

    await listConversationsForStaff(db, ADMIN_MANAGER);

    const messagesSelect = findMany.mock.calls[0]![0].select.messages;
    expect(messagesSelect.where).toBeUndefined();
    expect(messagesSelect.select.visibility).toBe(true);
  });
});
