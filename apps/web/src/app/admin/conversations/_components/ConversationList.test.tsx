// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ConversationCardView } from './ConversationCard';
import { ConversationList } from './ConversationList';
import type { ConversationReplyState } from './ConversationReplyForm';

const CREATED_AT = new Date('2026-09-01T08:00:00.000Z');

function conversation(clientFullName: string): ConversationCardView {
  return {
    category: 'GENERAL_INQUIRY',
    clientFullName,
    createdAt: CREATED_AT,
    messages: [
      {
        id: `${clientFullName}-message-1`,
        body: 'Hello.',
        visibility: 'CLIENT_VISIBLE',
        createdAt: CREATED_AT,
        authorLabel: clientFullName,
      },
    ],
  };
}

describe('ConversationList (D-051 §13, Stage 3)', () => {
  it('renders the empty state and no cards when there are no conversations', () => {
    render(<ConversationList conversations={[]} replyActions={[]} />);

    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('renders one card per conversation, in the order supplied', () => {
    render(
      <ConversationList
        conversations={[conversation('Juan Dela Cruz'), conversation('Maria Santos')]}
        replyActions={[vi.fn(), vi.fn()]}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Juan Dela Cruz', 'Maria Santos']);
    expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
  });

  it('binds each card to its own index-aligned reply action, never the wrong one', async () => {
    const user = userEvent.setup();
    const firstAction = vi
      .fn()
      .mockResolvedValue({ status: 'idle' } satisfies ConversationReplyState);
    const secondAction = vi
      .fn()
      .mockResolvedValue({ status: 'idle' } satisfies ConversationReplyState);

    render(
      <ConversationList
        conversations={[conversation('Juan Dela Cruz'), conversation('Maria Santos')]}
        replyActions={[firstAction, secondAction]}
      />,
    );

    const forms = document.querySelectorAll('form');
    expect(forms).toHaveLength(2);

    const secondCard = screen.getByRole('article', { name: 'Conversation with Maria Santos' });
    const textarea = secondCard.querySelector('textarea')!;
    await user.type(textarea, 'Reply to Maria');
    await user.click(secondCard.querySelector('input[value="CLIENT_VISIBLE"]')!);
    await user.click(secondCard.querySelector('button[type="submit"]')!);

    expect(secondAction).toHaveBeenCalledTimes(1);
    expect(firstAction).not.toHaveBeenCalled();
  });
});
