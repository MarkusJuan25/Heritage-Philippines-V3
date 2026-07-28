// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { StatusTransitionPanel, type StatusTransitionPanelProps } from './StatusTransitionPanel';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DEFAULT_PROPS: StatusTransitionPanelProps = {
  leadId: 'lead-1',
  currentStatus: 'QUALIFIED',
  options: [
    { status: 'NOT_PROCEEDING', reasonRequired: false },
    { status: 'DUPLICATE', reasonRequired: true },
    { status: 'ARCHIVED', reasonRequired: false },
  ],
};

function renderPanel(overrides: Partial<StatusTransitionPanelProps> = {}) {
  return render(<StatusTransitionPanel {...DEFAULT_PROPS} {...overrides} />);
}

async function selectStatus(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.selectOptions(screen.getByLabelText('Change status to'), label);
}

describe('StatusTransitionPanel', () => {
  it('displays the current status using the shared label', () => {
    renderPanel();

    expect(screen.getByText(/Current status:/)).toHaveTextContent('Qualified');
  });

  it('offers exactly the statuses passed as options, using their shared labels', () => {
    renderPanel();

    const select = screen.getByLabelText('Change status to');
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual(['Select a status…', 'Not Proceeding', 'Duplicate', 'Archived']);
  });

  it('never offers the current status or CONVERTED_TO_CLIENT, even if a caller mistakenly included them', () => {
    renderPanel({
      options: [
        { status: 'NOT_PROCEEDING', reasonRequired: false },
        { status: 'ARCHIVED', reasonRequired: false },
        // Deliberately included to prove the component's own defensive
        // filter — not just the caller's discipline — keeps these out.
        { status: 'QUALIFIED', reasonRequired: false },
        { status: 'CONVERTED_TO_CLIENT', reasonRequired: false },
      ],
    });

    expect(screen.queryByRole('option', { name: 'Qualified' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Converted to Client' })).not.toBeInTheDocument();
    // The legitimate options are still offered — the filter removes only
    // the prohibited two, nothing else.
    expect(screen.getByRole('option', { name: 'Not Proceeding' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Archived' })).toBeInTheDocument();
  });

  it('renders a no-options message when nothing is transitionable, without a form', () => {
    renderPanel({ options: [] });

    expect(screen.getByText('No status changes are available for this lead.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Change status to')).not.toBeInTheDocument();
  });

  it('shows the reason field only for a transition that requires one, and hides it again when reselected', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();

    await selectStatus(user, 'Duplicate');
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();

    await selectStatus(user, 'Not Proceeding');
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
  });

  it('requires a reason before submitting a reason-required transition', async () => {
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Duplicate');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('A reason is required for this transition.')).toBeInTheDocument();
  });

  it('sends the exact payload — target, reason, and confirmed expectedStatus — for a reason-required transition', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { lead: { id: 'lead-1', status: 'DUPLICATE' } }));
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Duplicate');
    await user.type(screen.getByLabelText('Reason'), 'Matches an existing record');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/leads/lead-1/status');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      expectedStatus: 'QUALIFIED',
      newStatus: 'DUPLICATE',
      reason: 'Matches an existing record',
    });
  });

  it('sends no reason key for a transition that does not require one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ expectedStatus: 'QUALIFIED', newStatus: 'NOT_PROCEEDING' });
    expect(body).not.toHaveProperty('reason');
  });

  it('never submits a reason entered for one transition alongside a different, later-selected transition (regression)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Duplicate');
    await user.type(screen.getByLabelText('Reason'), 'Matches an existing record');
    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('reason');
    expect(body).toEqual({ expectedStatus: 'QUALIFIED', newStatus: 'NOT_PROCEEDING' });
  });

  it('updates the displayed current status from the confirmed response, calls router.refresh(), and awaits refreshed options rather than showing stale ones', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByText(/Current status:/)).toHaveTextContent('Not Proceeding'),
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Status updated.');
    // `currentStatus` is still the pre-transition prop ('QUALIFIED') until
    // router.refresh()'s new props land — the stale options computed for
    // it (and the select that would offer them) must not be shown.
    expect(screen.queryByLabelText('Change status to')).not.toBeInTheDocument();
    expect(screen.getByText('Refreshing available status changes…')).toBeInTheDocument();
  });

  it('suppresses options computed for the previous status while awaiting router.refresh(), then shows the freshly refreshed options once props catch up (regression)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }),
    );
    const user = userEvent.setup();
    // The real QUALIFIED transition matrix (features/leads/transitions.ts):
    // Not Proceeding, Duplicate, Spam, Archived.
    const { rerender } = renderPanel({
      options: [
        { status: 'NOT_PROCEEDING', reasonRequired: false },
        { status: 'DUPLICATE', reasonRequired: true },
        { status: 'SPAM', reasonRequired: true },
        { status: 'ARCHIVED', reasonRequired: false },
      ],
    });

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByText(/Current status:/)).toHaveTextContent('Not Proceeding'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Status updated.');
    // Duplicate and Spam were legal targets from QUALIFIED, not from the
    // new confirmed status NOT_PROCEEDING — while still waiting for
    // router.refresh()'s fresh props, neither may be offered.
    expect(screen.queryByRole('option', { name: 'Duplicate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Spam' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Change status to')).not.toBeInTheDocument();

    // router.refresh() resolves: page.tsx re-renders with the real
    // NOT_PROCEEDING transition matrix (Under Review, Archived) as fresh
    // `currentStatus`/`options` props.
    rerender(
      <StatusTransitionPanel
        leadId="lead-1"
        currentStatus="NOT_PROCEEDING"
        options={[
          { status: 'UNDER_REVIEW', reasonRequired: true },
          { status: 'ARCHIVED', reasonRequired: false },
        ]}
      />,
    );

    expect(screen.getByLabelText('Change status to')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Under Review' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Archived' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Duplicate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Spam' })).not.toBeInTheDocument();
    // The confirmation persists until the user interacts again.
    expect(screen.getByRole('status')).toHaveTextContent('Status updated.');
  });

  it('does not optimistically change the displayed status before the server confirms it', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    // Still shows the original status while the request is in flight.
    expect(screen.getByText(/Current status:/)).toHaveTextContent('Qualified');

    resolveFetch(jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }));
    await waitFor(() =>
      expect(screen.getByText(/Current status:/)).toHaveTextContent('Not Proceeding'),
    );
  });

  it('handles a stale expectedStatus (LEAD_CONFLICT) safely, without changing the displayed status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'LEAD_CONFLICT',
          message: 'This lead has changed since it was last loaded. Refresh and try again.',
        },
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This lead has changed since it was last loaded. Refresh and try again.',
      ),
    );
    expect(screen.getByText('Qualified')).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('handles an INVALID_STATUS_TRANSITION response safely', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'INVALID_STATUS_TRANSITION', message: 'Cannot transition from A to B.' },
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot transition from A to B.'),
    );
    expect(screen.getByText('Qualified')).toBeInTheDocument();
  });

  it('handles a controlled ROLE_NOT_PERMITTED/authorization response safely', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: 'ROLE_NOT_PERMITTED',
          message: 'This role is not permitted to manage leads.',
        },
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This role is not permitted to manage leads.',
      ),
    );
  });

  it('handles a LEAD_NOT_FOUND response safely', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'LEAD_NOT_FOUND', message: 'Lead not found.' } }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Lead not found.'));
  });

  it('shows the generic alert on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while updating the lead status.',
      ),
    );
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('shows the generic alert when the response body is invalid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    } as Response);
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while updating the lead status.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed success envelope (invalid status) and shows the generic alert', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { lead: { id: 'lead-1', status: 'toString' } }));
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while updating the lead status.',
      ),
    );
    // The displayed status never changed to the malformed value.
    expect(screen.getByText('Qualified')).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed error envelope (empty error.code) and shows the generic alert', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: '', message: 'Conflict.' } }));
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while updating the lead status.');
  });

  it('disables Change Status while a request is pending, blocking repeated submission', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await selectStatus(user, 'Not Proceeding');
    await user.click(screen.getByRole('button', { name: 'Change Status' }));

    expect(screen.getByRole('button', { name: 'Changing…' })).toBeDisabled();

    resolveFetch(jsonResponse(200, { lead: { id: 'lead-1', status: 'NOT_PROCEEDING' } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
