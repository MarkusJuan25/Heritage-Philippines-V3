// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ClientConversationSummary } from '@/features/conversations/schemas';

import { ConversationCard } from './ConversationCard';

const CREATED_AT = new Date('2026-09-01T08:00:00.000Z');

function makeConversation(
  overrides: Partial<ClientConversationSummary> = {},
): ClientConversationSummary {
  return {
    category: 'BOOKING',
    createdAt: CREATED_AT,
    messages: [
      {
        body: 'Hello, I have a question about my booking.',
        createdAt: CREATED_AT,
        authorLabel: 'You',
      },
    ],
    ...overrides,
  };
}

describe('ConversationCard (D-051 §8/§9/§14/§15, Stage 4)', () => {
  it('renders an <article> naming the category and the started date', () => {
    render(<ConversationCard conversation={makeConversation()} action={vi.fn()} />);

    const article = screen.getByRole('article', { name: 'Booking conversation' });
    expect(within(article).getByRole('heading', { level: 2 })).toHaveTextContent('Booking');
    expect(within(article).getByText(/Started/)).toBeInTheDocument();
  });

  it("renders each message's author label, timestamp, and body", () => {
    render(
      <ConversationCard
        conversation={makeConversation({
          messages: [
            { body: 'When is my balance due?', createdAt: CREATED_AT, authorLabel: 'You' },
            {
              body: 'It is due on the 15th.',
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
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
    // <time> carries no implicit ARIA role, so its presence is checked
    // directly: one for "Started" plus one per message.
    expect(document.querySelectorAll('time')).toHaveLength(3);
  });

  it('renders markup-looking message bodies as literal plain text — never interpreted or executed', () => {
    const canary = '<script>window.__pwned = 1</script> <img src=x onerror=alert(1)>';
    const { container } = render(
      <ConversationCard
        conversation={makeConversation({
          messages: [{ body: canary, createdAt: CREATED_AT, authorLabel: 'You' }],
        })}
        action={vi.fn()}
      />,
    );

    expect(screen.getByText(canary)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('formats a timestamp in the Philippine timezone regardless of the host/test-runner timezone (Asia/Manila, UTC+8)', () => {
    // 2026-09-01T16:30:00.000Z is 2026-09-02T00:30:00 in Asia/Manila
    // (UTC+8) — deliberately chosen so the conversion crosses a calendar
    // date boundary, proving the explicit `timeZone: 'Asia/Manila'`
    // conversion is actually applied rather than the host's own local
    // timezone.
    const instant = new Date('2026-09-01T16:30:00.000Z');
    render(
      <ConversationCard
        conversation={makeConversation({
          createdAt: instant,
          messages: [{ body: 'Timestamp check.', createdAt: instant, authorLabel: 'You' }],
        })}
        action={vi.fn()}
      />,
    );

    const expected = 'Sep 2, 2026, 12:30 AM';
    expect(screen.getAllByText(expected)).toHaveLength(2); // the "Started" line and the one message
  });

  it('renders the reply form', () => {
    render(<ConversationCard conversation={makeConversation()} action={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
  });

  it('renders all eight category labels correctly', () => {
    const cases: Array<[ClientConversationSummary['category'], string]> = [
      ['GENERAL_INQUIRY', 'General Inquiry'],
      ['PROPOSAL_ROS', 'Proposal / ROS'],
      ['BOOKING', 'Booking'],
      ['PAYMENT', 'Payment'],
      ['DOCUMENTS', 'Documents'],
      ['VISA', 'Visa'],
      ['TRAVEL_PREPARATION', 'Travel Preparation'],
      ['TECHNICAL_SUPPORT', 'Technical Support'],
    ];
    for (const [category, label] of cases) {
      const view = render(
        <ConversationCard conversation={makeConversation({ category })} action={vi.fn()} />,
      );
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(label);
      view.unmount();
    }
  });

  it('never renders a Conversation.id, clientId, or Message.id — even smuggled onto the view object at runtime', () => {
    const tampered = {
      ...makeConversation(),
      id: 'conversation-should-never-render',
      clientId: 'client-should-never-render',
    } as ClientConversationSummary & { id: string; clientId: string };
    const { container } = render(<ConversationCard conversation={tampered} action={vi.fn()} />);

    expect(container.innerHTML).not.toContain('conversation-should-never-render');
    expect(container.innerHTML).not.toContain('client-should-never-render');
    expect(
      container.querySelectorAll('[data-conversation-id], [data-id], [data-client-id]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
  });
});
