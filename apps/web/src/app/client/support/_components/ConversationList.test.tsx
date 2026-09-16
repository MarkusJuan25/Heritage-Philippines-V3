// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ClientConversationSummary } from '@/features/conversations/schemas';

import { ConversationList } from './ConversationList';
import type { ClientConversationReplyState } from './ConversationReplyForm';

const CREATED_AT = new Date('2026-09-01T08:00:00.000Z');

function conversation(category: ClientConversationSummary['category']): ClientConversationSummary {
  return {
    category,
    createdAt: CREATED_AT,
    messages: [{ body: 'Hello.', createdAt: CREATED_AT, authorLabel: 'You' }],
  };
}

describe('ConversationList (D-051 §13, Stage 4)', () => {
  it('renders the empty state and no cards when there are no conversations', () => {
    render(<ConversationList conversations={[]} replyActions={[]} />);

    expect(
      screen.getByText('No conversations yet. Send a message below to get started.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('renders one card per conversation, in the order supplied', () => {
    render(
      <ConversationList
        conversations={[conversation('GENERAL_INQUIRY'), conversation('BOOKING')]}
        replyActions={[vi.fn(), vi.fn()]}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['General Inquiry', 'Booking']);
    expect(
      screen.queryByText('No conversations yet. Send a message below to get started.'),
    ).not.toBeInTheDocument();
  });

  it('binds each card to its own index-aligned reply action, never the wrong one', async () => {
    const user = userEvent.setup();
    const firstAction = vi
      .fn()
      .mockResolvedValue({ status: 'idle' } satisfies ClientConversationReplyState);
    const secondAction = vi
      .fn()
      .mockResolvedValue({ status: 'idle' } satisfies ClientConversationReplyState);

    render(
      <ConversationList
        conversations={[conversation('GENERAL_INQUIRY'), conversation('PAYMENT')]}
        replyActions={[firstAction, secondAction]}
      />,
    );

    const forms = document.querySelectorAll('form');
    expect(forms).toHaveLength(2);

    const secondCard = screen.getByRole('article', { name: 'Payment conversation' });
    const textarea = secondCard.querySelector('textarea')!;
    await user.type(textarea, 'Reply to the payment conversation');
    await user.click(secondCard.querySelector('button[type="submit"]')!);

    expect(secondAction).toHaveBeenCalledTimes(1);
    expect(firstAction).not.toHaveBeenCalled();
  });
});
