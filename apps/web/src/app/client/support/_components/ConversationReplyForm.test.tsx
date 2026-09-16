// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ClientConversationReplyState } from './ConversationReplyForm';
import { ConversationReplyForm } from './ConversationReplyForm';

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConversationReplyForm (D-051 §9/§15, Stage 4)', () => {
  it('renders a message textarea and a submit button — never a visibility control, hidden input, or data-* identifier attribute', () => {
    const { container } = render(<ConversationReplyForm action={vi.fn()} />);

    expect(screen.getByLabelText('Message')).toHaveAttribute('name', 'body');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(container.querySelector('[data-conversation-id], [data-id]')).toBeNull();
  });

  it('keeps submit disabled until a non-empty message is entered', async () => {
    const user = userEvent.setup();
    render(<ConversationReplyForm action={vi.fn()} />);

    const submit = screen.getByRole('button', { name: 'Send reply' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Message'), 'Hello');
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText('Message'));
    expect(submit).toBeDisabled();
  });

  it('submits ONLY body — never visibility, conversationId, author, or timestamp', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ClientConversationReplyState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ClientConversationReplyState>({ status: 'idle' });
    });
    render(<ConversationReplyForm action={action} />);

    await user.type(screen.getByLabelText('Message'), 'On it, checking now.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect([...calls[0]!.keys()]).toEqual(['body']);
    expect(calls[0]!.get('body')).toBe('On it, checking now.');
    expect(calls[0]!.get('visibility')).toBeNull();
  });

  it('shows a pending indicator and disables submit while the action is in flight', async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: ClientConversationReplyState) => void;
    const action = vi.fn(
      () =>
        new Promise<ClientConversationReplyState>((res) => {
          resolveAction = res;
        }),
    );
    render(<ConversationReplyForm action={action} />);

    await user.type(screen.getByLabelText('Message'), 'Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sending…'));
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled();

    resolveAction({ status: 'success' });
    await waitFor(() => expect(screen.queryByRole('status')).not.toHaveTextContent('Sending…'));
  });

  it('on error: preserves the entered message, shows a client-safe role="alert", and moves focus to it', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'error', code: 'CONVERSATION_FORBIDDEN' });
    render(<ConversationReplyForm action={action} />);

    await user.type(screen.getByLabelText('Message'), 'Following up on this.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This conversation is no longer accessible. Refresh the page to see the latest.',
    );
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Message')).toHaveValue('Following up on this.');
  });

  it('maps every controlled error code to non-revealing, identifier-free copy', async () => {
    const codes: Array<[ClientConversationReplyState & { status: 'error' }, string]> = [
      [{ status: 'error', code: 'UNAUTHENTICATED' }, 'session has expired'],
      [{ status: 'error', code: 'ROLE_NOT_PERMITTED' }, 'do not have permission'],
      [
        { status: 'error', code: 'CONVERSATION_FORBIDDEN' },
        'This conversation is no longer accessible',
      ],
      [{ status: 'error', code: 'VALIDATION_ERROR' }, 'enter a message'],
    ];
    for (const [state, fragment] of codes) {
      const user = userEvent.setup();
      const view = render(<ConversationReplyForm action={vi.fn().mockResolvedValue(state)} />);
      await user.type(screen.getByLabelText('Message'), 'Hello there');
      await user.click(screen.getByRole('button', { name: 'Send reply' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(fragment);
      expect(alert.textContent).not.toMatch(
        /prisma|P20\d\d|conversation-|client-|profile-|session-/i,
      );
      view.unmount();
    }
  });

  it('on success: shows a role="status" confirmation, clears the message, moves focus, and keeps the form usable for another reply', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'success' });
    render(<ConversationReplyForm action={action} />);

    await user.type(screen.getByLabelText('Message'), 'Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const status = await screen.findByText('Reply sent.');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveFocus();

    // The form is never permanently replaced — a Conversation reply is
    // repeatable, unlike a one-time Proposal response.
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  });

  it('supports two consecutive successful replies through the same mounted instance, with no stale state or cross-submission leakage', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ClientConversationReplyState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ClientConversationReplyState>({ status: 'success' });
    });
    render(<ConversationReplyForm action={action} />);

    await user.type(screen.getByLabelText('Message'), 'First message');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByText('Reply sent.');
    expect(screen.getByLabelText('Message')).toHaveValue('');

    await user.type(screen.getByLabelText('Message'), 'Second message');
    const submit = screen.getByRole('button', { name: 'Send reply' });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await screen.findByText('Reply sent.');
    expect(screen.getByLabelText('Message')).toHaveValue('');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.get('body')).toBe('First message');
    expect(calls[1]!.get('body')).toBe('Second message');
  });
});
