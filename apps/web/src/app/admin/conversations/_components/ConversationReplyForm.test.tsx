// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ConversationReplyState } from './ConversationReplyForm';
import { ConversationReplyForm } from './ConversationReplyForm';

afterEach(() => {
  vi.clearAllMocks();
});

async function fillAndSelect(
  user: ReturnType<typeof userEvent.setup>,
  body = 'Thanks for the update.',
) {
  await user.type(screen.getByLabelText('Message'), body);
  await user.click(screen.getByRole('radio', { name: 'Client-visible' }));
}

describe('ConversationReplyForm (D-051 §15/§16, Stage 3)', () => {
  it('renders a message textarea, two visibility options, and a submit button — never a hidden input or data-* identifier attribute', () => {
    const { container } = render(<ConversationReplyForm action={vi.fn()} />);

    expect(screen.getByLabelText('Message')).toHaveAttribute('name', 'body');
    const group = screen.getByRole('radiogroup', { name: 'Visibility' });
    expect(group).toBeInTheDocument();
    for (const name of ['Client-visible', 'Internal note']) {
      const radio = screen.getByRole('radio', { name });
      expect(radio).toHaveAttribute('name', 'visibility');
    }
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();

    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(container.querySelector('[data-conversation-id], [data-id]')).toBeNull();
  });

  it('keeps submit disabled until a non-empty message AND a visibility are both set', async () => {
    const user = userEvent.setup();
    render(<ConversationReplyForm action={vi.fn()} />);

    const submit = screen.getByRole('button', { name: 'Send reply' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Message'), 'Hello');
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText('Message'));
    expect(submit).toBeDisabled();
  });

  it('submits ONLY body and visibility — no conversationId, author, or timestamp field', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ConversationReplyState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ConversationReplyState>({ status: 'idle' });
    });
    render(<ConversationReplyForm action={action} />);

    await fillAndSelect(user, 'On it, checking now.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect([...calls[0]!.keys()].sort()).toEqual(['body', 'visibility']);
    expect(calls[0]!.get('body')).toBe('On it, checking now.');
    expect(calls[0]!.get('visibility')).toBe('CLIENT_VISIBLE');
  });

  it('shows a pending indicator and disables submit while the action is in flight', async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: ConversationReplyState) => void;
    const action = vi.fn(
      () =>
        new Promise<ConversationReplyState>((res) => {
          resolveAction = res;
        }),
    );
    render(<ConversationReplyForm action={action} />);

    await fillAndSelect(user);
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sending…'));
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled();

    resolveAction({ status: 'success' });
    await waitFor(() => expect(screen.queryByRole('status')).not.toHaveTextContent('Sending…'));
  });

  it('on error: preserves the entered message and selection, shows a client-safe role="alert", and moves focus to it', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'error', code: 'CONVERSATION_FORBIDDEN' });
    render(<ConversationReplyForm action={action} />);

    await fillAndSelect(user, 'Following up on this.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This conversation is no longer accessible. Refresh the page to see the latest.',
    );
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Message')).toHaveValue('Following up on this.');
    expect(screen.getByRole('radio', { name: 'Client-visible' })).toBeChecked();
  });

  it('maps every controlled error code to non-revealing, identifier-free copy', async () => {
    const codes: Array<[ConversationReplyState & { status: 'error' }, string]> = [
      [{ status: 'error', code: 'UNAUTHENTICATED' }, 'session has expired'],
      [{ status: 'error', code: 'ROLE_NOT_PERMITTED' }, 'do not have permission'],
      [
        { status: 'error', code: 'CONVERSATION_FORBIDDEN' },
        'This conversation is no longer accessible',
      ],
      [{ status: 'error', code: 'VALIDATION_ERROR' }, 'enter a message and choose a visibility'],
    ];
    for (const [state, fragment] of codes) {
      const user = userEvent.setup();
      const view = render(<ConversationReplyForm action={vi.fn().mockResolvedValue(state)} />);
      await fillAndSelect(user);
      await user.click(screen.getByRole('button', { name: 'Send reply' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(fragment);
      expect(alert.textContent).not.toMatch(
        /prisma|P20\d\d|conversation-|client-|profile-|session-/i,
      );
      view.unmount();
    }
  });

  it('on success: shows a role="status" confirmation, clears the message and visibility, moves focus, and keeps the form usable for another reply', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'success' });
    render(<ConversationReplyForm action={action} />);

    await fillAndSelect(user, 'Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    const status = await screen.findByText('Reply sent.');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveFocus();

    // The form is never permanently replaced — a Conversation reply is
    // repeatable, unlike a one-time Proposal response.
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Client-visible' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Internal note' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  });

  it('supports two consecutive successful replies through the same mounted instance, with no stale state or cross-submission leakage', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ConversationReplyState, formData: FormData) => {
      calls.push(formData);
      // A fresh object each time — `useActionState` never returns the
      // same reference twice, exactly mirroring what the real
      // `page.tsx`-built action does (`return { status: 'success' };`
      // is a new literal on every call).
      return Promise.resolve<ConversationReplyState>({ status: 'success' });
    });
    render(<ConversationReplyForm action={action} />);

    // --- First reply ---
    await user.type(screen.getByLabelText('Message'), 'First message');
    await user.click(screen.getByRole('radio', { name: 'Client-visible' }));
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await screen.findByText('Reply sent.');
    expect(action).toHaveBeenCalledTimes(1);

    // Reset exactly once after the first success.
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Client-visible' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Internal note' })).not.toBeChecked();

    // The form remains enabled and usable — not permanently disabled or
    // replaced (unlike ProposalResponseForm's one-time response).
    const submit = screen.getByRole('button', { name: 'Send reply' });
    expect(submit).toBeDisabled(); // blocked again until re-filled, not stuck from the prior submit
    expect(screen.getByLabelText('Message')).toBeEnabled();

    // --- Second reply: a different body AND a different visibility,
    // specifically to prove neither the first submission's values nor a
    // stale success state leak into this one. ---
    await user.type(screen.getByLabelText('Message'), 'Second message');
    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await screen.findByText('Reply sent.');

    // Reset again after the second success.
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Client-visible' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Internal note' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();

    // The action received exactly the right body/visibility for each
    // call, in order — never the other submission's values, and never a
    // conversationId/author/timestamp field on either call.
    expect(calls).toHaveLength(2);
    expect([...calls[0]!.keys()].sort()).toEqual(['body', 'visibility']);
    expect(calls[0]!.get('body')).toBe('First message');
    expect(calls[0]!.get('visibility')).toBe('CLIENT_VISIBLE');
    expect([...calls[1]!.keys()].sort()).toEqual(['body', 'visibility']);
    expect(calls[1]!.get('body')).toBe('Second message');
    expect(calls[1]!.get('visibility')).toBe('INTERNAL_NOTE');
  });
});
