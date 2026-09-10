// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ClientProposalResponseState } from '@/features/proposals/service';

import { ProposalResponseForm } from './ProposalResponseForm';

const ACK_LABEL = 'I understand this response is final for this proposal version.';
const SUCCESS_TEXT =
  "Your response has been recorded. This response can't be changed for this version.";

async function selectAcceptAndAcknowledge(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: 'Accept' }));
  await user.click(screen.getByRole('checkbox', { name: ACK_LABEL }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProposalResponseForm (D-047 §6/§9/§12)', () => {
  it('renders a fieldset/legend, three labelled radio options, the exact acknowledgement checkbox, and a submit button', () => {
    render(<ProposalResponseForm action={vi.fn()} versionNumber={4} />);

    const group = screen.getByRole('group', {
      name: 'How would you like to respond to Version 4?',
    });
    for (const name of ['Accept', 'Decline', 'Request changes']) {
      expect(within(group).getByRole('radio', { name })).toHaveAttribute('name', 'responseType');
    }
    const ack = screen.getByRole('checkbox', { name: ACK_LABEL });
    expect(ack).toHaveAttribute('name', 'acknowledgement');
    expect(screen.getByRole('button', { name: 'Submit response' })).toBeInTheDocument();
  });

  it('keeps submit disabled until a response type AND the acknowledgement are both set', async () => {
    const user = userEvent.setup();
    render(<ProposalResponseForm action={vi.fn()} versionNumber={1} />);

    const submit = screen.getByRole('button', { name: 'Submit response' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Decline' }));
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: ACK_LABEL }));
    expect(submit).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: ACK_LABEL })); // uncheck
    expect(submit).toBeDisabled();
  });

  it('submits ONLY responseType and acknowledgement — no identifier, timestamp, or hidden input', async () => {
    const user = userEvent.setup();
    const calls: FormData[] = [];
    const action = vi.fn((_state: ClientProposalResponseState, formData: FormData) => {
      calls.push(formData);
      return Promise.resolve<ClientProposalResponseState>({ status: 'idle' });
    });
    const { container } = render(<ProposalResponseForm action={action} versionNumber={2} />);

    expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
    expect(container.querySelector('[data-proposal-version-id], [data-proposal-id]')).toBeNull();

    await selectAcceptAndAcknowledge(user);
    await user.click(screen.getByRole('button', { name: 'Submit response' }));

    expect(action).toHaveBeenCalledTimes(1);
    expect([...calls[0]!.keys()].sort()).toEqual(['acknowledgement', 'responseType']);
    expect(calls[0]!.get('responseType')).toBe('ACCEPT');
    expect(calls[0]!.get('acknowledgement')).toBe('on');
  });

  it('shows a pending indicator and disables submit while the action is in flight', async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: ClientProposalResponseState) => void;
    const action = vi.fn(
      () =>
        new Promise<ClientProposalResponseState>((res) => {
          resolveAction = res;
        }),
    );
    render(<ProposalResponseForm action={action} versionNumber={1} />);

    await selectAcceptAndAcknowledge(user);
    await user.click(screen.getByRole('button', { name: 'Submit response' }));

    await waitFor(() => expect(screen.getByText('Submitting your response…')).toBeInTheDocument());
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveTextContent('Submitting…');

    resolveAction({ status: 'error', code: 'PROPOSAL_CONFLICT' });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText('Submitting your response…')).not.toBeInTheDocument();
  });

  it('on error: keeps the form with selections intact, shows a client-safe role="alert" message, and moves focus to it', async () => {
    const user = userEvent.setup();
    const action = vi
      .fn()
      .mockResolvedValue({ status: 'error', code: 'PROPOSAL_VERSION_SUPERSEDED' });
    render(<ProposalResponseForm action={action} versionNumber={1} />);

    await selectAcceptAndAcknowledge(user);
    await user.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Your travel consultant has published a newer version of this proposal. Refresh the page to see the latest.',
    );
    expect(alert).toHaveFocus();
    // The form is kept and the selections are preserved (never cleared on a rejected submit).
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Accept' })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: ACK_LABEL })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Submit response' })).toBeInTheDocument();
  });

  it('maps every controlled error code to identifier-free copy (no Prisma text, id, or session value)', async () => {
    const codes: Array<[ClientProposalResponseState & { status: 'error' }, string]> = [
      [
        { status: 'error', code: 'FORBIDDEN' },
        'contact your Heritage Philippines travel consultant',
      ],
      [{ status: 'error', code: 'VALIDATION_ERROR' }, 'Please choose a response'],
      [
        { status: 'error', code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED' },
        'A response has already been recorded',
      ],
      [{ status: 'error', code: 'PROPOSAL_VERSION_NOT_CURRENT' }, 'no longer the current one'],
      [{ status: 'error', code: 'PROPOSAL_CONFLICT' }, 'conflicting update'],
    ];
    for (const [state, fragment] of codes) {
      const user = userEvent.setup();
      const view = render(
        <ProposalResponseForm action={vi.fn().mockResolvedValue(state)} versionNumber={1} />,
      );
      await selectAcceptAndAcknowledge(user);
      await user.click(screen.getByRole('button'));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(fragment);
      expect(alert.textContent).not.toMatch(/prisma|P20\d\d|session-|profile-|clientId/i);
      view.unmount();
    }
  });

  it('on success: replaces the form with a role="status" confirmation and moves focus to it', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ status: 'success', responseType: 'ACCEPT' });
    render(<ProposalResponseForm action={action} versionNumber={1} />);

    await selectAcceptAndAcknowledge(user);
    await user.click(screen.getByRole('button'));

    const status = await screen.findByText(SUCCESS_TEXT);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Submit response' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
