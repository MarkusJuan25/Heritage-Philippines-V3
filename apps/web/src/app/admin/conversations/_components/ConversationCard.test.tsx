// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ConversationCard, type ConversationCardView } from './ConversationCard';

const CREATED_AT = new Date('2026-09-01T08:00:00.000Z');

function makeConversation(overrides: Partial<ConversationCardView> = {}): ConversationCardView {
  return {
    category: 'BOOKING',
    clientFullName: 'Juan Dela Cruz',
    createdAt: CREATED_AT,
    messages: [
      {
        id: 'message-1',
        body: 'Hello, I have a question about my booking.',
        visibility: 'CLIENT_VISIBLE',
        createdAt: CREATED_AT,
        authorLabel: 'Juan Dela Cruz',
      },
    ],
    ...overrides,
  };
}

describe('ConversationCard (D-051 §8/§9/§14/§15/§16, Stage 3)', () => {
  it('renders an <article> naming the client, the category label, and the started date', () => {
    render(<ConversationCard conversation={makeConversation()} action={vi.fn()} />);

    const article = screen.getByRole('article', { name: 'Conversation with Juan Dela Cruz' });
    expect(within(article).getByRole('heading', { level: 2 })).toHaveTextContent('Juan Dela Cruz');
    expect(within(article).getByText(/Booking/)).toBeInTheDocument();
    expect(within(article).getByText(/Started/)).toBeInTheDocument();
  });

  it('formats a timestamp in the Philippine timezone regardless of the host/test-runner timezone (Asia/Manila, UTC+8)', () => {
    // 2026-09-01T16:30:00.000Z is 2026-09-02T00:30:00 in Asia/Manila
    // (UTC+8) — deliberately chosen so the conversion crosses a calendar
    // date boundary, proving the explicit `timeZone: 'Asia/Manila'`
    // conversion is actually applied rather than the host's own local
    // timezone (which would show 2026-09-01 for most other zones). This
    // assertion is stable under any TZ the test runner's host/CI uses,
    // since `timeZone` is passed explicitly to `toLocaleString` rather
    // than relying on the process's implicit timezone.
    const instant = new Date('2026-09-01T16:30:00.000Z');
    render(
      <ConversationCard
        conversation={makeConversation({
          createdAt: instant,
          messages: [
            {
              id: 'message-1',
              body: 'Timestamp check.',
              visibility: 'CLIENT_VISIBLE',
              createdAt: instant,
              authorLabel: 'Juan Dela Cruz',
            },
          ],
        })}
        action={vi.fn()}
      />,
    );

    const expected = 'Sep 2, 2026, 12:30 AM';
    expect(screen.getAllByText(expected)).toHaveLength(2); // the "Started" line and the one message
  });

  it("renders each message's author label, timestamp, and body", () => {
    render(
      <ConversationCard
        conversation={makeConversation({
          clientFullName: 'Overview Client',
          messages: [
            {
              id: 'message-1',
              body: 'When is my balance due?',
              visibility: 'CLIENT_VISIBLE',
              createdAt: CREATED_AT,
              authorLabel: 'Juan Dela Cruz',
            },
            {
              id: 'message-2',
              body: 'It is due on the 15th.',
              visibility: 'CLIENT_VISIBLE',
              createdAt: new Date('2026-09-01T09:00:00.000Z'),
              authorLabel: 'Maria Santos',
            },
          ],
        })}
        action={vi.fn()}
      />,
    );

    expect(screen.getByText('When is my balance due?')).toBeInTheDocument();
    expect(screen.getByText('It is due on the 15th.')).toBeInTheDocument();
    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
    // <time> carries no implicit ARIA role, so its presence is checked
    // directly: one for "Started" plus one per message.
    expect(document.querySelectorAll('time')).toHaveLength(3);
  });

  it('visibly distinguishes an INTERNAL_NOTE message from a CLIENT_VISIBLE one in the same thread (D-051 §8/§16)', () => {
    render(
      <ConversationCard
        conversation={makeConversation({
          messages: [
            {
              id: 'message-1',
              body: 'Client-facing reply.',
              visibility: 'CLIENT_VISIBLE',
              createdAt: CREATED_AT,
              authorLabel: 'Maria Santos',
            },
            {
              id: 'message-2',
              body: 'Internal-only note about this client.',
              visibility: 'INTERNAL_NOTE',
              createdAt: CREATED_AT,
              authorLabel: 'Maria Santos',
            },
          ],
        })}
        action={vi.fn()}
      />,
    );

    // Scoped to the message list — the reply form below also renders
    // "Client-visible"/"Internal note" as its own visibility radio labels.
    const messageList = screen.getByRole('list');
    expect(within(messageList).getByText('Client-visible')).toBeInTheDocument();
    expect(within(messageList).getByText('Internal note')).toBeInTheDocument();
    // Distinguished by more than color alone — each carries its own visible
    // text label, and each uses a different CSS class.
    const clientBadge = within(messageList).getByText('Client-visible');
    const internalBadge = within(messageList).getByText('Internal note');
    expect(clientBadge.className).not.toBe(internalBadge.className);
  });

  it('renders markup-looking message bodies as literal plain text — never interpreted or executed', () => {
    const canary = '<script>window.__pwned = 1</script> <img src=x onerror=alert(1)>';
    const { container } = render(
      <ConversationCard
        conversation={makeConversation({
          messages: [
            {
              id: 'message-1',
              body: canary,
              visibility: 'CLIENT_VISIBLE',
              createdAt: CREATED_AT,
              authorLabel: 'Juan Dela Cruz',
            },
          ],
        })}
        action={vi.fn()}
      />,
    );

    expect(screen.getByText(canary)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('renders the reply form', () => {
    render(<ConversationCard conversation={makeConversation()} action={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
  });

  it('never renders a Conversation.id or clientId — even one smuggled onto the view object at runtime', () => {
    const tampered = {
      ...makeConversation(),
      id: 'conversation-should-never-render',
      clientId: 'client-should-never-render',
    } as ConversationCardView & { id: string; clientId: string };
    const { container } = render(<ConversationCard conversation={tampered} action={vi.fn()} />);

    expect(container.innerHTML).not.toContain('conversation-should-never-render');
    expect(container.innerHTML).not.toContain('client-should-never-render');
    expect(
      container.querySelectorAll('[data-conversation-id], [data-id], [data-client-id]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
  });
});
