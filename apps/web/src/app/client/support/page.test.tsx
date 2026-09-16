// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock, getCurrentSessionMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  getCurrentSessionMock: vi.fn(),
}));
vi.mock('@/lib/auth/guards', () => ({
  getCurrentUser: getCurrentUserMock,
  getCurrentSession: getCurrentSessionMock,
}));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { listConversationsForClientMock, createConversationAsClientMock, replyAsClientMock } =
  vi.hoisted(() => ({
    listConversationsForClientMock: vi.fn(),
    createConversationAsClientMock: vi.fn(),
    replyAsClientMock: vi.fn(),
  }));
vi.mock('@/features/conversations/service', () => ({
  listConversationsForClient: listConversationsForClientMock,
  createConversationAsClient: createConversationAsClientMock,
  replyAsClient: replyAsClientMock,
}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

// Passes through to the REAL `ConversationList` component (rather than
// stubbing it out entirely) so this file can both capture the composed
// props at the boundary AND verify what actually lands in the rendered
// DOM two layers down (`ConversationCard`/`ConversationReplyForm`/
// `CreateConversationForm`) — the same technique
// `admin/conversations/page.test.tsx` (D-051 Stage 3) uses.
const { conversationListPropsSpy } = vi.hoisted(() => ({ conversationListPropsSpy: vi.fn() }));
vi.mock('./_components/ConversationList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_components/ConversationList')>();
  return {
    ConversationList: (props: Parameters<typeof actual.ConversationList>[0]) => {
      conversationListPropsSpy(props);
      return actual.ConversationList(props);
    },
  };
});

// Same passthrough-spy technique, applied to `CreateConversationForm` so
// its own bound `action` (the single, page-level creation Server Action)
// can be captured and invoked directly, exactly as `replyActions` are
// captured via `ConversationList` above.
const { createFormPropsSpy } = vi.hoisted(() => ({ createFormPropsSpy: vi.fn() }));
vi.mock('./_components/CreateConversationForm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_components/CreateConversationForm')>();
  return {
    CreateConversationForm: (props: Parameters<typeof actual.CreateConversationForm>[0]) => {
      createFormPropsSpy(props);
      return actual.CreateConversationForm(props);
    },
  };
});

import { ClientError } from '@/features/clients/errors';
import { ConversationError } from '@/features/conversations/errors';

import type { ClientConversationReplyAction } from './_components/ConversationReplyForm';
import ClientSupportPage from './page';

const CLIENT_USER = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client',
  role: 'CLIENT',
};
const OWNED = {
  clientId: 'client-secret-id-1',
  fullName: 'Juan Dela Cruz',
  email: null,
  phone: null,
};
const SESSION = { user: CLIENT_USER, sessionId: 'session-xyz' };

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    category: 'GENERAL_INQUIRY',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    messages: [
      {
        body: 'Hello, I need help.',
        createdAt: new Date('2026-09-01T08:00:00.000Z'),
        authorLabel: 'You',
      },
    ],
    ...overrides,
  };
}

function serverCard(id: string) {
  return { id };
}

function lastConversationListProps() {
  return conversationListPropsSpy.mock.calls.at(-1)![0] as {
    conversations: unknown[];
    replyActions: ClientConversationReplyAction[];
  };
}

function replyFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('body', 'Thanks for reaching out.');
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

function createFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('category', 'GENERAL_INQUIRY');
  fd.set('body', 'I need help with my booking.');
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

function frameworkFields(fd: FormData) {
  fd.set('$ACTION_ID_1c8f9a2b7d4e5f60', '1');
  fd.set('$ACTION_REF_1', '');
  fd.set('$ACTION_1:0', '{"id":"1c8f9a2b7d4e5f60","bound":"$@1"}');
  fd.set('$ACTION_1:1', '[{"conversationId":"conversation-HACKER"}]');
  return fd;
}

async function renderPageAndGetProps() {
  const jsx = await ClientSupportPage();
  render(jsx);
  return lastConversationListProps();
}

beforeEach(() => {
  vi.clearAllMocks();
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  getCurrentUserMock.mockResolvedValue(CLIENT_USER);
  getCurrentSessionMock.mockResolvedValue(SESSION);
  getOwnClientForUserMock.mockResolvedValue(OWNED);
  listConversationsForClientMock.mockResolvedValue({ render: [], serverModel: [] });
});

describe('ClientSupportPage — access behavior (D-051 §7/§10)', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(ClientSupportPage()).rejects.toThrow('REDIRECT:/login');
    expect(listConversationsForClientMock).not.toHaveBeenCalled();
  });

  it('resolves the client via Contract A and calls listConversationsForClient with the owned clientId', async () => {
    await renderPageAndGetProps();

    expect(getOwnClientForUserMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(listConversationsForClientMock).toHaveBeenCalledWith(CLIENT_USER, OWNED.clientId);
  });

  it('renders nothing (returns null) when Contract A finds no owned Client — the layout owns that panel', async () => {
    getOwnClientForUserMock.mockResolvedValue(null);

    const jsx = await ClientSupportPage();

    expect(jsx).toBeNull();
    expect(listConversationsForClientMock).not.toHaveBeenCalled();
  });

  it('renders nothing when Contract A throws ClientError(ROLE_NOT_PERMITTED) — the layout owns that panel', async () => {
    getOwnClientForUserMock.mockRejectedValue(
      new ClientError('ROLE_NOT_PERMITTED', 'This role is not permitted.'),
    );

    const jsx = await ClientSupportPage();

    expect(jsx).toBeNull();
  });

  it('renders nothing when listConversationsForClient throws ConversationError(ROLE_NOT_PERMITTED)', async () => {
    listConversationsForClientMock.mockRejectedValue(
      new ConversationError('ROLE_NOT_PERMITTED', 'This role is not permitted.'),
    );

    const jsx = await ClientSupportPage();

    expect(jsx).toBeNull();
  });

  it('propagates any other unexpected error instead of swallowing it', async () => {
    getOwnClientForUserMock.mockRejectedValue(new Error('db exploded'));

    await expect(ClientSupportPage()).rejects.toThrow('db exploded');
  });

  it('propagates a ConversationError with an unexpected code (e.g. CONVERSATION_FORBIDDEN) from the initial read', async () => {
    listConversationsForClientMock.mockRejectedValue(
      new ConversationError('CONVERSATION_FORBIDDEN', 'irrelevant'),
    );

    await expect(ClientSupportPage()).rejects.toThrow();
  });
});

describe('ClientSupportPage — rendering and identifier containment (D-051 §9/§15)', () => {
  it('renders the empty state when there are no conversations', async () => {
    const jsx = await ClientSupportPage();
    render(jsx);

    expect(
      screen.getByText('No conversations yet. Send a message below to get started.'),
    ).toBeInTheDocument();
  });

  it('passes result.render as-is to ConversationList and never leaks the real clientId into it', async () => {
    listConversationsForClientMock.mockResolvedValue({
      render: [conversationRow()],
      serverModel: [serverCard('conversation-secret-id-1')],
    });

    const props = await renderPageAndGetProps();

    expect(props.conversations).toEqual([conversationRow()]);
    expect(props.conversations[0]).not.toHaveProperty('id');
    expect(props.conversations[0]).not.toHaveProperty('clientId');
    expect(JSON.stringify(props.conversations)).not.toContain(OWNED.clientId);
    expect(JSON.stringify(props.conversations)).not.toContain('conversation-secret-id-1');
  });

  it('never leaks the real Conversation.id or clientId into the rendered DOM', async () => {
    listConversationsForClientMock.mockResolvedValue({
      render: [conversationRow()],
      serverModel: [serverCard('conversation-secret-id-1')],
    });

    const jsx = await ClientSupportPage();
    const { container } = render(jsx);

    expect(container.innerHTML).not.toContain('conversation-secret-id-1');
    expect(container.innerHTML).not.toContain(OWNED.clientId);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-conversation-id], [data-id], [data-client-id]'),
    ).toHaveLength(0);
  });

  it('builds one reply action per conversation, index-aligned with serverModel', async () => {
    listConversationsForClientMock.mockResolvedValue({
      render: [conversationRow(), conversationRow({ category: 'BOOKING' })],
      serverModel: [serverCard('conversation-1'), serverCard('conversation-2')],
    });

    const props = await renderPageAndGetProps();

    expect(props.replyActions).toHaveLength(2);
    expect(typeof props.replyActions[0]).toBe('function');
    expect(typeof props.replyActions[1]).toBe('function');
  });
});

function lastCreateFormProps() {
  return createFormPropsSpy.mock.calls.at(-1)![0] as {
    action: (state: unknown, formData: FormData) => Promise<unknown>;
  };
}

async function getCreateAction() {
  const jsx = await ClientSupportPage();
  render(jsx);
  return lastCreateFormProps().action;
}

describe('ClientSupportPage — create Server Action (D-051 §2/§9)', () => {
  it('re-authenticates from a fresh session and fails closed when none exists', async () => {
    const action = await getCreateAction();
    getCurrentSessionMock.mockResolvedValue(null);

    const result = await action({ status: 'idle' }, createFormData());

    expect(result).toEqual({ status: 'error', code: 'UNAUTHENTICATED' });
    expect(createConversationAsClientMock).not.toHaveBeenCalled();
  });

  it('resolves the acting client fresh via Contract A inside the action and fails closed when none is owned', async () => {
    const action = await getCreateAction();
    getOwnClientForUserMock.mockResolvedValue(null);

    const result = await action({ status: 'idle' }, createFormData());

    expect(result).toEqual({ status: 'error', code: 'CONVERSATION_FORBIDDEN' });
    expect(createConversationAsClientMock).not.toHaveBeenCalled();
  });

  it('maps a ClientError(ROLE_NOT_PERMITTED) from Contract A to the same safe forbidden state', async () => {
    const action = await getCreateAction();
    getOwnClientForUserMock.mockRejectedValue(new ClientError('ROLE_NOT_PERMITTED', 'irrelevant'));

    const result = await action({ status: 'idle' }, createFormData());

    expect(result).toEqual({ status: 'error', code: 'CONVERSATION_FORBIDDEN' });
    expect(createConversationAsClientMock).not.toHaveBeenCalled();
  });

  it('submits exactly category and body to createConversationAsClient, with the owned clientId — never a client-supplied one', async () => {
    const action = await getCreateAction();
    createConversationAsClientMock.mockResolvedValue(undefined);

    const result = await action(
      { status: 'idle' },
      createFormData({ category: 'PAYMENT', body: 'Question about my invoice.' }),
    );

    expect(createConversationAsClientMock).toHaveBeenCalledWith(CLIENT_USER, OWNED.clientId, {
      category: 'PAYMENT',
      body: 'Question about my invoice.',
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/client/support');
    expect(result).toEqual({ status: 'success' });
  });

  it('strips $ACTION_-prefixed framework fields and still reaches the service on a valid submit', async () => {
    const action = await getCreateAction();
    createConversationAsClientMock.mockResolvedValue(undefined);

    const result = await action({ status: 'idle' }, frameworkFields(createFormData()));

    expect(createConversationAsClientMock).toHaveBeenCalledWith(
      CLIENT_USER,
      OWNED.clientId,
      expect.objectContaining({ category: 'GENERAL_INQUIRY' }),
    );
    expect(result).toEqual({ status: 'success' });
  });

  it('rejects a forged extra field (e.g. clientId) as VALIDATION_ERROR, even alongside valid $ACTION_ fields', async () => {
    const action = await getCreateAction();

    const result = await action(
      { status: 'idle' },
      frameworkFields(createFormData({ clientId: 'client-HACKER' })),
    );

    expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
    expect(createConversationAsClientMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or invalid category/body as VALIDATION_ERROR before calling createConversationAsClient', async () => {
    const action = await getCreateAction();

    const missingCategory = new FormData();
    missingCategory.set('body', 'Hello');
    expect(await action({ status: 'idle' }, missingCategory)).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    expect(
      await action({ status: 'idle' }, createFormData({ category: 'NOT_A_REAL_CATEGORY' })),
    ).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });

    expect(createConversationAsClientMock).not.toHaveBeenCalled();
  });

  it.each(['ROLE_NOT_PERMITTED', 'CONVERSATION_FORBIDDEN', 'VALIDATION_ERROR'] as const)(
    'maps a ConversationError with code %s to the identical controlled error state, without revalidating',
    async (code) => {
      const action = await getCreateAction();
      createConversationAsClientMock.mockRejectedValue(new ConversationError(code, 'irrelevant'));

      const result = await action({ status: 'idle' }, createFormData());

      expect(result).toEqual({ status: 'error', code });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it('rethrows any unexpected non-ConversationError instead of swallowing it', async () => {
    const action = await getCreateAction();
    createConversationAsClientMock.mockRejectedValue(new Error('db exploded'));

    await expect(action({ status: 'idle' }, createFormData())).rejects.toThrow('db exploded');
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe('ClientSupportPage — reply Server Action (D-051 §7/§15/§16/§17)', () => {
  async function getReplyAction(id = 'conversation-secret-id-1') {
    listConversationsForClientMock.mockResolvedValue({
      render: [conversationRow()],
      serverModel: [serverCard(id)],
    });
    const props = await renderPageAndGetProps();
    return props.replyActions[0]!;
  }

  it('re-authenticates from a fresh session and fails closed when none exists', async () => {
    const action = await getReplyAction();
    getCurrentSessionMock.mockResolvedValue(null);

    const result = await action({ status: 'idle' }, replyFormData());

    expect(result).toEqual({ status: 'error', code: 'UNAUTHENTICATED' });
    expect(replyAsClientMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('resolves the acting client fresh via Contract A inside the action and fails closed when none is owned', async () => {
    const action = await getReplyAction();
    getOwnClientForUserMock.mockResolvedValue(null);

    const result = await action({ status: 'idle' }, replyFormData());

    expect(result).toEqual({ status: 'error', code: 'CONVERSATION_FORBIDDEN' });
    expect(replyAsClientMock).not.toHaveBeenCalled();
  });

  it('binds the closure-captured Conversation.id from serverModel — the plain reply form never even offers such a field — and revalidates only on success', async () => {
    const action = await getReplyAction('conversation-secret-id-1');
    replyAsClientMock.mockResolvedValue(undefined);

    const result = await action({ status: 'idle' }, replyFormData());

    expect(replyAsClientMock).toHaveBeenCalledWith(CLIENT_USER, OWNED.clientId, {
      conversationId: 'conversation-secret-id-1',
      body: 'Thanks for reaching out.',
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/client/support');
    expect(result).toEqual({ status: 'success' });
  });

  it('index-aligns each reply action to its own conversation — never the wrong one', async () => {
    listConversationsForClientMock.mockResolvedValue({
      render: [conversationRow(), conversationRow({ category: 'BOOKING' })],
      serverModel: [serverCard('conversation-1'), serverCard('conversation-2')],
    });
    replyAsClientMock.mockResolvedValue(undefined);
    const props = await renderPageAndGetProps();

    await props.replyActions[1]!({ status: 'idle' }, replyFormData());

    expect(replyAsClientMock).toHaveBeenCalledWith(
      CLIENT_USER,
      OWNED.clientId,
      expect.objectContaining({ conversationId: 'conversation-2' }),
    );
  });

  it('rejects a submitted conversationId as an unexpected field (strict schema), proving the form itself cannot supply or override one', async () => {
    const action = await getReplyAction('conversation-secret-id-1');

    const result = await action(
      { status: 'idle' },
      replyFormData({ conversationId: 'conversation-HACKER' }),
    );

    expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
    expect(replyAsClientMock).not.toHaveBeenCalled();
  });

  it('rejects a submitted visibility field as an unexpected field — a client reply can never create an INTERNAL_NOTE message', async () => {
    const action = await getReplyAction();

    const result = await action({ status: 'idle' }, replyFormData({ visibility: 'INTERNAL_NOTE' }));

    expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
    expect(replyAsClientMock).not.toHaveBeenCalled();
  });

  it('strips $ACTION_-prefixed framework fields (including an embedded forged conversationId) and still reaches the service on a valid submit', async () => {
    const action = await getReplyAction('conversation-secret-id-1');
    replyAsClientMock.mockResolvedValue(undefined);

    const result = await action({ status: 'idle' }, frameworkFields(replyFormData()));

    expect(replyAsClientMock).toHaveBeenCalledWith(
      CLIENT_USER,
      OWNED.clientId,
      expect.objectContaining({ conversationId: 'conversation-secret-id-1' }),
    );
    expect(result).toEqual({ status: 'success' });
  });

  it('rejects a missing or invalid body as VALIDATION_ERROR before calling replyAsClient', async () => {
    const action = await getReplyAction();

    expect(await action({ status: 'idle' }, new FormData())).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });
    expect(await action({ status: 'idle' }, replyFormData({ body: '   ' }))).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    expect(replyAsClientMock).not.toHaveBeenCalled();
  });

  it.each(['ROLE_NOT_PERMITTED', 'CONVERSATION_FORBIDDEN', 'VALIDATION_ERROR'] as const)(
    'maps a ConversationError with code %s to the identical controlled error state, without revalidating',
    async (code) => {
      const action = await getReplyAction();
      replyAsClientMock.mockRejectedValue(new ConversationError(code, 'irrelevant'));

      const result = await action({ status: 'idle' }, replyFormData());

      expect(result).toEqual({ status: 'error', code });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it('rethrows any unexpected non-ConversationError instead of swallowing it', async () => {
    const action = await getReplyAction();
    replyAsClientMock.mockRejectedValue(new Error('db exploded'));

    await expect(action({ status: 'idle' }, replyFormData())).rejects.toThrow('db exploded');
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('never reads, displays, or mutates lastReadAt anywhere in the action or its inputs', async () => {
    const action = await getReplyAction();
    replyAsClientMock.mockResolvedValue(undefined);

    await action({ status: 'idle' }, replyFormData());

    const [, , input] = replyAsClientMock.mock.calls[0]!;
    expect(input).not.toHaveProperty('lastReadAt');
  });
});
