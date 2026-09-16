// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ClientConversationCreateState } from './CreateConversationForm';
import { CreateConversationForm } from './CreateConversationForm';

const ALL_CATEGORY_LABELS = [
  'General Inquiry',
  'Proposal / ROS',
  'Booking',
  'Payment',
  'Documents',
  'Visa',
  'Travel Preparation',
  'Technical Support',
];

afterEach(() => {
  vi.clearAllMocks();
});

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Category'), 'General Inquiry');
  await user.type(screen.getByLabelText('Message'), 'I have a question.');
}

describe('CreateConversationForm (D-051 §2/§9, Stage 4)', () => {
  it('renders a category select offering all eight categories, a message textarea, and a submit button — never a hidden input or data-* identifier attribute', () => {
    const { container } = render(<CreateConversationForm action={vi.fn()} />);

    const select = screen.getByLabelText('Category');
    expect(select).toHaveAttribute('name', 'category');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    for (const label of ALL_CATEGORY_LABELS) {
      expect(options).toContain(label);
    }
    expect(options).toHaveLength(ALL_CATEGORY_LABELS.length + 1); // + the "Select a category…" placeholder

    expect(screen.getByLabelText('Message')).toHaveAttribute('name', 'body');
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeInTheDocument();

    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(
      container.querySelector('[data-conversation-id], [data-client-id], [data-id]'),
    ).toBeNull();
  });

  it('keeps submit disabled until BOTH a category and a non-empty message are set', async () => {
    const user = userEvent.setup();
    render(<CreateConversationForm action={vi.fn()} />);

    const submit = screen.getByRole('button', { name: 'Start conversation' });
    expect(submit).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Category'), 'General Inquiry');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Message'), 'Hello');
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText('Message'));
    expect(submit).toBeDisabled();
  });

  it('submits ONLY category and body — never visibility, identity, timestamp, or participant fields', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ClientConversationCreateState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ClientConversationCreateState>({ status: 'idle' });
    });
    render(<CreateConversationForm action={action} />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect([...calls[0]!.keys()].sort()).toEqual(['body', 'category']);
    expect(calls[0]!.get('category')).toBe('GENERAL_INQUIRY');
    expect(calls[0]!.get('body')).toBe('I have a question.');
  });

  it('shows a pending indicator and disables submit while the action is in flight', async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: ClientConversationCreateState) => void;
    const action = vi.fn(
      () =>
        new Promise<ClientConversationCreateState>((res) => {
          resolveAction = res;
        }),
    );
    render(<CreateConversationForm action={action} />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sending…'));
    expect(screen.getByRole('button', { name: /Starting/ })).toBeDisabled();

    resolveAction({ status: 'success' });
    await waitFor(() => expect(screen.queryByRole('status')).not.toHaveTextContent('Sending…'));
  });

  it('on error: preserves the entered category and message, shows a client-safe role="alert", and moves focus to it', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'error', code: 'VALIDATION_ERROR' });
    render(<CreateConversationForm action={action} />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please choose a category and enter a message before sending.');
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Category')).toHaveValue('GENERAL_INQUIRY');
    expect(screen.getByLabelText('Message')).toHaveValue('I have a question.');
  });

  it('maps every controlled error code to non-revealing, identifier-free copy', async () => {
    const codes: Array<[ClientConversationCreateState & { status: 'error' }, string]> = [
      [{ status: 'error', code: 'UNAUTHENTICATED' }, 'session has expired'],
      [{ status: 'error', code: 'ROLE_NOT_PERMITTED' }, 'do not have permission'],
      [{ status: 'error', code: 'CONVERSATION_FORBIDDEN' }, 'We could not start this conversation'],
      [{ status: 'error', code: 'VALIDATION_ERROR' }, 'choose a category'],
    ];
    for (const [state, fragment] of codes) {
      const user = userEvent.setup();
      const view = render(<CreateConversationForm action={vi.fn().mockResolvedValue(state)} />);
      await fillValidForm(user);
      await user.click(screen.getByRole('button', { name: 'Start conversation' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(fragment);
      expect(alert.textContent).not.toMatch(
        /prisma|P20\d\d|conversation-|client-|profile-|session-/i,
      );
      view.unmount();
    }
  });

  it('on success: shows a role="status" confirmation, clears category and message, moves focus, and keeps the form usable for another conversation', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'success' });
    render(<CreateConversationForm action={action} />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));

    const status = await screen.findByText('Conversation started.');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveFocus();

    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveValue('');
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
  });

  it('supports two consecutive successful conversation creations through the same mounted instance, with no stale state or cross-submission leakage', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ClientConversationCreateState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ClientConversationCreateState>({ status: 'success' });
    });
    render(<CreateConversationForm action={action} />);

    await user.selectOptions(screen.getByLabelText('Category'), 'General Inquiry');
    await user.type(screen.getByLabelText('Message'), 'First conversation.');
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    await screen.findByText('Conversation started.');
    expect(screen.getByLabelText('Category')).toHaveValue('');
    expect(screen.getByLabelText('Message')).toHaveValue('');

    await user.selectOptions(screen.getByLabelText('Category'), 'Payment');
    await user.type(screen.getByLabelText('Message'), 'Second conversation.');
    const submit = screen.getByRole('button', { name: 'Start conversation' });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await screen.findByText('Conversation started.');
    expect(screen.getByLabelText('Category')).toHaveValue('');
    expect(screen.getByLabelText('Message')).toHaveValue('');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.get('category')).toBe('GENERAL_INQUIRY');
    expect(calls[0]!.get('body')).toBe('First conversation.');
    expect(calls[1]!.get('category')).toBe('PAYMENT');
    expect(calls[1]!.get('body')).toBe('Second conversation.');
  });
});
