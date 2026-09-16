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

const { listConversationsForStaffMock, replyAsStaffMock } = vi.hoisted(() => ({
  listConversationsForStaffMock: vi.fn(),
  replyAsStaffMock: vi.fn(),
}));
vi.mock('@/features/conversations/service', () => ({
  listConversationsForStaff: listConversationsForStaffMock,
  replyAsStaff: replyAsStaffMock,
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
// DOM two layers down (`ConversationCard`/`ConversationReplyForm`) — the
// same technique `client/my-journey/page.test.tsx` uses for
// `ProposalReviewList`, extended with a real-render passthrough for the
// identifier-safety assertions below.
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

import { ConversationError } from '@/features/conversations/errors';

import type { ConversationReplyAction } from './_components/ConversationReplyForm';
import AdminConversationsPage from './page';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};

const SESSION = { user: ADMIN_MANAGER, sessionId: 'session-xyz' };

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-secret-id-1',
    clientId: 'client-secret-id-1',
    clientFullName: 'Juan Dela Cruz',
    category: 'GENERAL_INQUIRY',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    messages: [
      {
        id: 'message-1',
        body: 'Hello, I need help.',
        visibility: 'CLIENT_VISIBLE',
        createdAt: new Date('2026-09-01T08:00:00.000Z'),
        authorStaffUser: null,
        authorLabel: 'Juan Dela Cruz',
      },
    ],
    ...overrides,
  };
}

function lastConversationListProps() {
  return conversationListPropsSpy.mock.calls.at(-1)![0] as {
    conversations: unknown[];
    replyActions: ConversationReplyAction[];
  };
}

function replyFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('body', 'Thanks for reaching out.');
  fd.set('visibility', 'CLIENT_VISIBLE');
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

// Mirrors what Next.js injects into a Server Action's submitted FormData
// for progressive enhancement. The blob deliberately mentions a fake
// conversationId to prove the closure binding never consults submitted
// data (D-051 §15).
function frameworkFormData(overrides: Record<string, string> = {}) {
  const fd = replyFormData(overrides);
  fd.set('$ACTION_ID_1c8f9a2b7d4e5f60', '1');
  fd.set('$ACTION_REF_1', '');
  fd.set('$ACTION_1:0', '{"id":"1c8f9a2b7d4e5f60","bound":"$@1"}');
  fd.set('$ACTION_1:1', '[{"conversationId":"conversation-HACKER"}]');
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `vi.clearAllMocks()` strips every mock's implementation, including
  // `redirectMock`'s throwing behavior set at creation time — without
  // restoring it here, only the very first test to exercise a redirect
  // would ever see it actually throw (mirrors
  // admin/proposals/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  getCurrentSessionMock.mockResolvedValue(SESSION);
  listConversationsForStaffMock.mockResolvedValue([]);
});

describe('AdminConversationsPage — role gate (D-051 §5/§6, Decision 3)', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminConversationsPage()).rejects.toThrow('REDIRECT:/login');
    expect(listConversationsForStaffMock).not.toHaveBeenCalled();
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION'])(
    'admits staff role %s and calls listConversationsForStaff',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });
      listConversationsForStaffMock.mockResolvedValue([]);

      const jsx = await AdminConversationsPage();
      render(jsx);

      expect(listConversationsForStaffMock).toHaveBeenCalledWith(expect.objectContaining({ role }));
      expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
    },
  );

  it.each(['SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'denies role %s with an in-place "Access denied" state, never calling listConversationsForStaff',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminConversationsPage();
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(listConversationsForStaffMock).not.toHaveBeenCalled();
    },
  );
});

describe('AdminConversationsPage — rendering', () => {
  it('renders the empty state when there are no conversations', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listConversationsForStaffMock.mockResolvedValue([]);

    const jsx = await AdminConversationsPage();
    render(jsx);

    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
  });

  it('maps each row to a conversation view with no id or clientId, and one index-aligned reply action', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listConversationsForStaffMock.mockResolvedValue([
      conversationRow(),
      conversationRow({
        id: 'conversation-secret-id-2',
        clientId: 'client-secret-id-2',
        clientFullName: 'Maria Santos',
      }),
    ]);

    const jsx = await AdminConversationsPage();
    render(jsx);

    const props = lastConversationListProps();
    expect(props.conversations).toHaveLength(2);
    for (const view of props.conversations) {
      expect(view).not.toHaveProperty('id');
      expect(view).not.toHaveProperty('clientId');
    }
    expect(props.replyActions).toHaveLength(2);
    expect(typeof props.replyActions[0]).toBe('function');
  });

  it('never leaks the real Conversation.id or clientId into the rendered DOM', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listConversationsForStaffMock.mockResolvedValue([conversationRow()]);

    const jsx = await AdminConversationsPage();
    const { container } = render(jsx);

    expect(container.innerHTML).not.toContain('conversation-secret-id-1');
    expect(container.innerHTML).not.toContain('client-secret-id-1');
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-conversation-id], [data-id], [data-client-id]'),
    ).toHaveLength(0);
  });
});

describe('AdminConversationsPage — reply Server Action (D-051 §15/§16/§17)', () => {
  async function actionForFirstRow() {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listConversationsForStaffMock.mockResolvedValue([conversationRow()]);
    const jsx = await AdminConversationsPage();
    render(jsx);
    return lastConversationListProps().replyActions[0]!;
  }

  it('re-authenticates from a fresh session and fails closed when none exists', async () => {
    const action = await actionForFirstRow();
    getCurrentSessionMock.mockResolvedValue(null);

    const result = await action({ status: 'idle' }, replyFormData());

    expect(result).toEqual({ status: 'error', code: 'UNAUTHENTICATED' });
    expect(replyAsStaffMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('binds the closure-captured Conversation.id — the plain reply form never even offers such a field — and revalidates only on success', async () => {
    const action = await actionForFirstRow();
    replyAsStaffMock.mockResolvedValue(undefined);

    // The form itself submits only `body`/`visibility` (enforced by
    // `conversationReplyFormSchema`'s `.strict()`, proven separately
    // below); there is no legitimate way for a caller to supply
    // `conversationId` at all, so its presence in this call can only have
    // come from the action's own closure over `row.id`.
    const result = await action({ status: 'idle' }, replyFormData());

    expect(replyAsStaffMock).toHaveBeenCalledWith(ADMIN_MANAGER, {
      conversationId: 'conversation-secret-id-1',
      body: 'Thanks for reaching out.',
      visibility: 'CLIENT_VISIBLE',
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/admin/conversations');
    expect(result).toEqual({ status: 'success' });
  });

  it('rejects a submitted conversationId as an unexpected field (strict schema), proving the form itself cannot supply one', async () => {
    const action = await actionForFirstRow();

    const result = await action(
      { status: 'idle' },
      replyFormData({ conversationId: 'conversation-HACKER' }),
    );

    expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
    expect(replyAsStaffMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('strips $ACTION_-prefixed framework fields and still reaches the service on a valid submit', async () => {
    const action = await actionForFirstRow();
    replyAsStaffMock.mockResolvedValue(undefined);

    const result = await action({ status: 'idle' }, frameworkFormData());

    expect(replyAsStaffMock).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      expect.objectContaining({ conversationId: 'conversation-secret-id-1' }),
    );
    expect(result).toEqual({ status: 'success' });
  });

  it('rejects an ordinary forged extra field as VALIDATION_ERROR, even alongside valid $ACTION_ fields', async () => {
    const action = await actionForFirstRow();

    const result = await action(
      { status: 'idle' },
      frameworkFormData({ authorStaffUserId: 'staff-HACKER' }),
    );

    expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
    expect(replyAsStaffMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or invalid body/visibility as VALIDATION_ERROR before calling replyAsStaff', async () => {
    const action = await actionForFirstRow();

    const missingBody = new FormData();
    missingBody.set('visibility', 'CLIENT_VISIBLE');
    expect(await action({ status: 'idle' }, missingBody)).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    expect(
      await action({ status: 'idle' }, replyFormData({ visibility: 'NOT_A_REAL_VALUE' })),
    ).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });

    expect(replyAsStaffMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it.each(['ROLE_NOT_PERMITTED', 'CONVERSATION_FORBIDDEN', 'VALIDATION_ERROR'] as const)(
    'maps a ConversationError with code %s to the identical controlled error state, without revalidating',
    async (code) => {
      const action = await actionForFirstRow();
      replyAsStaffMock.mockRejectedValue(new ConversationError(code, 'irrelevant message'));

      const result = await action({ status: 'idle' }, replyFormData());

      expect(result).toEqual({ status: 'error', code });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it('rethrows any unexpected non-ConversationError instead of swallowing it', async () => {
    const action = await actionForFirstRow();
    replyAsStaffMock.mockRejectedValue(new Error('db exploded'));

    await expect(action({ status: 'idle' }, replyFormData())).rejects.toThrow('db exploded');
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('never reads, displays, or mutates lastReadAt anywhere in the action or its inputs', async () => {
    const action = await actionForFirstRow();
    replyAsStaffMock.mockResolvedValue(undefined);

    await action({ status: 'idle' }, replyFormData());

    const [, input] = replyAsStaffMock.mock.calls[0]!;
    expect(input).not.toHaveProperty('lastReadAt');
  });
});
