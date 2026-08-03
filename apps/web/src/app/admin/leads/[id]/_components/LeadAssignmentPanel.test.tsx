// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { LeadAssignmentPanel, type LeadAssignmentPanelProps } from './LeadAssignmentPanel';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

type EligibleFixture = { id: string; name: string; email: string };

function eligibleResponse(items: EligibleFixture[] = []): Response {
  return jsonResponse(200, { items, page: 1, pageSize: 100, total: items.length });
}

function makeConsultants(count: number, offset: number): EligibleFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tc-${offset + i}`,
    name: `Consultant ${offset + i}`,
    email: `consultant${offset + i}@example.test`,
  }));
}

function assignmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-1',
    assignedStaffId: 'tc-1',
    assignedByUserId: 'admin-1',
    leadId: 'lead-1',
    clientId: null,
    bookingId: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

const ASSIGNMENT_URL = '/api/leads/lead-1/assignment';
const ELIGIBLE_URL_PREFIX = '/api/assignments/travel-consultants';

/**
 * Routes the shared `fetchMock` by URL — the eligible-consultant `GET` and
 * the assign/reassign/end `PUT`/`DELETE` are two entirely different
 * endpoints, unlike EditLeadForm's single-endpoint mock chains.
 */
function mockFetch(handlers: { eligible?: () => Response; mutate?: () => Response }) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
      return Promise.resolve((handlers.eligible ?? (() => eligibleResponse()))());
    }
    return Promise.resolve((handlers.mutate ?? (() => jsonResponse(200, { assignment: null })))());
  });
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

const DEFAULT_PROPS: LeadAssignmentPanelProps = {
  leadId: 'lead-1',
  role: 'ADMIN_MANAGER',
  currentAssignment: null,
};

function renderPanel(overrides: Partial<LeadAssignmentPanelProps> = {}) {
  return render(<LeadAssignmentPanel {...DEFAULT_PROPS} {...overrides} />);
}

function assignedConsultantSummary(): HTMLElement {
  const summary = screen.getByText('Assigned Consultant:').closest('p');
  if (!summary) throw new Error('Assigned Consultant summary paragraph not found');
  return summary;
}

describe('LeadAssignmentPanel', () => {
  describe('ADMIN_MANAGER — first assignment', () => {
    it('renders no reason field for a first assignment and submits the exact PUT payload', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-1' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      expect(screen.queryByLabelText('Reason for reassignment')).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL);
        expect(call).toBeDefined();
      });
      const [, init] = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL) as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('PUT');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body as string)).toEqual({ assignedStaffId: 'tc-1' });

      await waitFor(() => expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos'));
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('ADMIN_MANAGER — reassignment', () => {
    const CURRENT = { staffId: 'tc-1', staffName: 'Maria Santos' };
    const ELIGIBLE: EligibleFixture[] = [
      { id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' },
      { id: 'tc-2', name: 'Pedro Reyes', email: 'pedro@example.test' },
    ];

    it('requires and submits a reason, with the exact PUT payload', async () => {
      mockFetch({
        eligible: () => eligibleResponse(ELIGIBLE),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-2' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      expect(screen.getByLabelText('Reason for reassignment')).toBeInTheDocument();
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Workload rebalance');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL);
        expect(call).toBeDefined();
      });
      const [, init] = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL) as [
        string,
        RequestInit,
      ];
      expect(JSON.parse(init.body as string)).toEqual({
        assignedStaffId: 'tc-2',
        reason: 'Workload rebalance',
      });
    });

    it('blocks submission client-side when the reason is left blank', async () => {
      mockFetch({ eligible: () => eligibleResponse(ELIGIBLE) });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(
        screen.getByText('A reason is required when replacing an existing assignment.'),
      ).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => url === ASSIGNMENT_URL)).toBe(false);
    });

    it('maps a server-side REASON_REQUIRED error to the reassignment reason field', async () => {
      mockFetch({
        eligible: () => eligibleResponse(ELIGIBLE),
        mutate: () =>
          jsonResponse(409, {
            error: {
              code: 'REASON_REQUIRED',
              message: 'A reason is required when replacing an existing assignment.',
            },
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      // Client-side blank-reason blocking (already covered above) never
      // fires here — the field is populated, so the request actually
      // reaches the server, whose own REASON_REQUIRED response must still
      // land on the same reason field, not the generic form alert.
      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'x');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() =>
        expect(
          screen.getByText('A reason is required when replacing an existing assignment.'),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('maps a reason-targeting VALIDATION_ERROR detail to the reassignment reason field', async () => {
      mockFetch({
        eligible: () => eligibleResponse(ELIGIBLE),
        mutate: () =>
          jsonResponse(400, {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'The request did not pass validation.',
              details: [{ path: 'reason', message: 'reason must be at most 500 characters' }],
            },
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'x');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() =>
        expect(screen.getByText('reason must be at most 500 characters')).toBeInTheDocument(),
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('never submits when the selected consultant is already the current assignee', async () => {
      mockFetch({ eligible: () => eligibleResponse(ELIGIBLE) });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');

      expect(screen.getByRole('button', { name: 'Reassign' })).toBeDisabled();
      expect(fetchMock.mock.calls.some(([url]) => url === ASSIGNMENT_URL)).toBe(false);
    });

    it('displays the assignee confirmed by the response, never the raw selection alone', async () => {
      mockFetch({
        eligible: () => eligibleResponse(ELIGIBLE),
        // The response confirms tc-2, proving the display follows the
        // server's own confirmation rather than the local selection.
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-2' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Workload rebalance');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(assignedConsultantSummary()).toHaveTextContent('Pedro Reyes'));
      expect(assignedConsultantSummary()).not.toHaveTextContent('Maria Santos');
    });
  });

  describe('ADMIN_MANAGER — ending an assignment', () => {
    const CURRENT = { staffId: 'tc-1', staffName: 'Maria Santos' };

    it('requires and submits a reason, with the exact DELETE payload', async () => {
      mockFetch({
        eligible: () => eligibleResponse([]),
        mutate: () =>
          jsonResponse(200, {
            assignment: assignmentRecord({ endedAt: '2026-07-24T00:00:00.000Z' }),
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(
        screen.getByLabelText('Reason for ending assignment'),
        'Consultant left the team',
      );
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL);
        expect(call).toBeDefined();
      });
      const [, init] = fetchMock.mock.calls.find(([url]) => url === ASSIGNMENT_URL) as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('DELETE');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body as string)).toEqual({ reason: 'Consultant left the team' });

      await waitFor(() => expect(assignedConsultantSummary()).toHaveTextContent('Unassigned'));
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('blocks submission client-side when the reason is left blank', async () => {
      mockFetch({ eligible: () => eligibleResponse([]) });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      expect(
        screen.getByText('A reason is required when ending an assignment.'),
      ).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => url === ASSIGNMENT_URL)).toBe(false);
    });

    it('maps a reason-targeting VALIDATION_ERROR detail to the end-assignment reason field', async () => {
      mockFetch({
        eligible: () => eligibleResponse([]),
        mutate: () =>
          jsonResponse(400, {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'The request did not pass validation.',
              details: [{ path: 'reason', message: 'reason must be at most 500 characters' }],
            },
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'x');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() =>
        expect(screen.getByText('reason must be at most 500 characters')).toBeInTheDocument(),
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('idempotently treats { assignment: null } as a successful end', async () => {
      mockFetch({
        eligible: () => eligibleResponse([]),
        mutate: () => jsonResponse(200, { assignment: null }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: CURRENT });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Already inactive');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment ended.'),
      );
      expect(assignedConsultantSummary()).toHaveTextContent('Unassigned');
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('ADMIN_MANAGER — eligible-consultant loading', () => {
    it('shows a loading state while the eligible list is being fetched', async () => {
      let resolveEligible: (value: Response) => void = () => {};
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return new Promise<Response>((resolve) => {
            resolveEligible = resolve;
          });
        }
        return Promise.resolve(jsonResponse(200, { assignment: null }));
      });
      renderPanel();

      expect(screen.getByRole('status')).toHaveTextContent('Loading eligible Travel Consultants…');

      resolveEligible(eligibleResponse([]));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('shows an empty state when no eligible Travel Consultants are available', async () => {
      mockFetch({ eligible: () => eligibleResponse([]) });
      renderPanel();

      await waitFor(() =>
        expect(
          screen.getByText('No eligible Travel Consultants are currently available.'),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
    });

    it('shows a controlled error when the eligible-consultant fetch fails', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return Promise.resolve(jsonResponse(200, { assignment: null }));
      });
      renderPanel();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while loading eligible Travel Consultants',
        ),
      );
      expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
    });
  });

  describe('ADMIN_MANAGER — mutation failure handling', () => {
    it('shows the server error message when the assignment mutation fails', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(409, {
            error: {
              code: 'ASSIGNEE_INACTIVE',
              message: 'The specified staff member is not active and cannot be assigned.',
            },
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'The specified staff member is not active and cannot be assigned.',
        ),
      );
    });

    it('shows the LEAD_NOT_FOUND server message through the generic form alert', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(404, {
            error: { code: 'LEAD_NOT_FOUND', message: 'Lead not found.' },
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Lead not found.'));
    });

    it('rejects a malformed success envelope (missing assignedStaffId) and shows the generic alert', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () => jsonResponse(200, { assignment: { id: 'assignment-1', endedAt: null } }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the generic alert on a network failure during the mutation', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
          );
        }
        return Promise.reject(new TypeError('Failed to fetch'));
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
    });

    it('shows the generic alert when the response body is not valid JSON', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
          );
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        } as unknown as Response);
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
    });
  });

  describe('ADMIN_MANAGER — pending-request behavior', () => {
    it('disables the assign controls while a mutation request is pending', async () => {
      let resolveMutation: (value: Response) => void = () => {};
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        });
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(screen.getByLabelText('Assign to')).toBeDisabled();

      resolveMutation(
        jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-1' }) }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument(),
      );
    });

    it('disables the end-assignment controls while a mutation request is pending', async () => {
      let resolveMutation: (value: Response) => void = () => {};
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(eligibleResponse([]));
        }
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        });
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Left the team');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      expect(screen.getByRole('button', { name: 'Ending…' })).toBeDisabled();
      expect(screen.getByLabelText('Reason for ending assignment')).toBeDisabled();

      resolveMutation(
        jsonResponse(200, {
          assignment: assignmentRecord({ endedAt: '2026-07-24T00:00:00.000Z' }),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Ending…' })).not.toBeInTheDocument(),
      );
    });
  });

  describe('TRAVEL_CONSULTANT — read-only', () => {
    it('renders read-only assignment information with the current consultant, and no fetch', () => {
      renderPanel({
        role: 'TRAVEL_CONSULTANT',
        currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' },
      });

      expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders Unassigned read-only when there is no active assignment', () => {
      renderPanel({ role: 'TRAVEL_CONSULTANT', currentAssignment: null });

      expect(assignedConsultantSummary()).toHaveTextContent('Unassigned');
    });

    it('renders no interactive control of any kind — not merely disabled Admin controls', () => {
      const { container } = renderPanel({
        role: 'TRAVEL_CONSULTANT',
        currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' },
      });

      expect(container.querySelectorAll('select, button, textarea, input')).toHaveLength(0);
      expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
    });

    it.each(['SYSTEM_ADMINISTRATOR', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'CLIENT'])(
      'renders read-only for role %s as well, with no fetch',
      (role) => {
        renderPanel({
          role: role as LeadAssignmentPanelProps['role'],
          currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' },
        });

        expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('Prop synchronization', () => {
    it('updates the displayed assignment and its name when the currentAssignment prop changes', () => {
      mockFetch({ eligible: () => eligibleResponse([]) });
      const { rerender } = renderPanel({
        currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' },
      });

      expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');

      rerender(
        <LeadAssignmentPanel
          {...DEFAULT_PROPS}
          currentAssignment={{ staffId: 'tc-2', staffName: 'Pedro Reyes' }}
        />,
      );

      expect(assignedConsultantSummary()).toHaveTextContent('Pedro Reyes');
      expect(assignedConsultantSummary()).not.toHaveTextContent('Maria Santos');
    });

    it('does not overwrite a just-confirmed optimistic update with an unchanged (stale) currentAssignment prop', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-1' }) }),
      });
      const user = userEvent.setup();
      const { rerender } = renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos'));

      // Simulates an unrelated re-render with the SAME (still stale, not
      // yet refreshed) `currentAssignment` prop — router.refresh() from the
      // mutation above has not resolved yet — must not clobber the
      // just-confirmed optimistic display.
      rerender(<LeadAssignmentPanel {...DEFAULT_PROPS} currentAssignment={null} />);

      expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');
    });

    it('resets all transient form state when leadId changes, without a remount', async () => {
      mockFetch({ eligible: () => eligibleResponse([]) });
      const user = userEvent.setup();
      const { rerender } = renderPanel({
        leadId: 'lead-1',
        currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' },
      });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      // Leaves an in-progress, unsaved validation error on the FIRST Lead.
      await user.click(screen.getByRole('button', { name: 'End assignment' }));
      expect(
        screen.getByText('A reason is required when ending an assignment.'),
      ).toBeInTheDocument();

      // Navigates to a DIFFERENT Lead, unassigned there — without this
      // component remounting (same instance, only its props change).
      rerender(<LeadAssignmentPanel {...DEFAULT_PROPS} leadId="lead-2" currentAssignment={null} />);

      expect(
        screen.queryByText('A reason is required when ending an assignment.'),
      ).not.toBeInTheDocument();
      expect(assignedConsultantSummary()).toHaveTextContent('Unassigned');
      expect(screen.queryByRole('button', { name: 'End assignment' })).not.toBeInTheDocument();
    });
  });

  describe('Mutation response validation', () => {
    it('rejects a PUT response with a non-null endedAt', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, {
            assignment: assignmentRecord({
              assignedStaffId: 'tc-1',
              endedAt: '2026-07-24T00:00:00.000Z',
            }),
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
      expect(assignedConsultantSummary()).toHaveTextContent('Unassigned');
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('rejects a PUT response targeting a different Lead', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, {
            assignment: assignmentRecord({ assignedStaffId: 'tc-1', leadId: 'lead-99' }),
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
      expect(assignedConsultantSummary()).toHaveTextContent('Unassigned');
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('rejects a DELETE response with endedAt null', async () => {
      mockFetch({
        eligible: () => eligibleResponse([]),
        mutate: () => jsonResponse(200, { assignment: assignmentRecord({ endedAt: null }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Left the team');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
      expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('rejects a DELETE response targeting a different Lead', async () => {
      mockFetch({
        eligible: () => eligibleResponse([]),
        mutate: () =>
          jsonResponse(200, {
            assignment: assignmentRecord({
              endedAt: '2026-07-24T00:00:00.000Z',
              leadId: 'lead-99',
            }),
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Left the team');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment',
        ),
      );
      expect(assignedConsultantSummary()).toHaveTextContent('Maria Santos');
      expect(refreshMock).not.toHaveBeenCalled();
    });
  });

  describe('Cross-operation state', () => {
    it('shows the progress label only on the active (End) button, never on Reassign', async () => {
      let resolveMutation: (value: Response) => void = () => {};
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        });
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Left the team');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      expect(screen.getByRole('button', { name: 'Ending…' })).toBeDisabled();
      // Cross-operation blocking disables Reassign too, but it must keep
      // its own idle label — never borrow End's progress label.
      expect(screen.getByRole('button', { name: 'Reassign' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();

      resolveMutation(
        jsonResponse(200, {
          assignment: assignmentRecord({ endedAt: '2026-07-24T00:00:00.000Z' }),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Ending…' })).not.toBeInTheDocument(),
      );
    });

    it('shows the progress label only on the active (Reassign) button, never on End assignment', async () => {
      let resolveMutation: (value: Response) => void = () => {};
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([
              { id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' },
              { id: 'tc-2', name: 'Pedro Reyes', email: 'pedro@example.test' },
            ]),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        });
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Workload rebalance');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'End assignment' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Ending…' })).not.toBeInTheDocument();

      resolveMutation(
        jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-2' }) }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument(),
      );
    });

    it('clears a stale End Assignment validation error after a successful reassignment', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([
            { id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' },
            { id: 'tc-2', name: 'Pedro Reyes', email: 'pedro@example.test' },
          ]),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-2' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: 'End assignment' }));
      expect(
        screen.getByText('A reason is required when ending an assignment.'),
      ).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Workload rebalance');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.'),
      );
      expect(
        screen.queryByText('A reason is required when ending an assignment.'),
      ).not.toBeInTheDocument();
    });

    it('does not display both success messages after ending, then starting a new assignment', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, {
            assignment: assignmentRecord({ endedAt: '2026-07-24T00:00:00.000Z' }),
          }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText('Reason for ending assignment'), 'Left the team');
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment ended.'),
      );

      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          return Promise.resolve(
            eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
          );
        }
        return Promise.resolve(
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-1' }) }),
        );
      });
      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1));
      expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.');
    });
  });

  describe('Eligible-consultant pagination', () => {
    it('fetches subsequent pages when total exceeds the first page, aggregating every item into the selector', async () => {
      const page1 = makeConsultants(100, 0);
      const page2 = makeConsultants(1, 100);
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          if (url.includes('page=2')) {
            return Promise.resolve(
              jsonResponse(200, { items: page2, page: 2, pageSize: 100, total: 101 }),
            );
          }
          return Promise.resolve(
            jsonResponse(200, { items: page1, page: 1, pageSize: 100, total: 101 }),
          );
        }
        return Promise.resolve(jsonResponse(200, { assignment: null }));
      });
      renderPanel();

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      expect(fetchMock.mock.calls.some(([url]) => url.includes('page=2'))).toBe(true);
      expect(screen.getByRole('option', { name: 'Consultant 100' })).toBeInTheDocument();
      // The first page's own last item is present too — proves
      // aggregation, not replacement.
      expect(screen.getByRole('option', { name: 'Consultant 99' })).toBeInTheDocument();
    });

    it('shows the controlled loading error, not a partial list, when a later page is malformed', async () => {
      const page1 = makeConsultants(100, 0);
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          if (url.includes('page=2')) {
            return Promise.resolve(jsonResponse(200, { items: 'not-an-array' }));
          }
          return Promise.resolve(
            jsonResponse(200, { items: page1, page: 1, pageSize: 100, total: 101 }),
          );
        }
        return Promise.resolve(jsonResponse(200, { assignment: null }));
      });
      renderPanel();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while loading eligible Travel Consultants',
        ),
      );
      expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
    });

    it('shows the controlled loading error, not a partial list, when a later page fetch fails outright', async () => {
      const page1 = makeConsultants(100, 0);
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith(ELIGIBLE_URL_PREFIX)) {
          if (url.includes('page=2')) {
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          return Promise.resolve(
            jsonResponse(200, { items: page1, page: 1, pageSize: 100, total: 101 }),
          );
        }
        return Promise.resolve(jsonResponse(200, { assignment: null }));
      });
      renderPanel();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while loading eligible Travel Consultants',
        ),
      );
      expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('gives every reassignment control an accessible name and wires aria-invalid/aria-describedby on error', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-2', name: 'Pedro Reyes', email: 'pedro@example.test' }]),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      const reasonField = screen.getByLabelText('Reason for reassignment');
      expect(reasonField).toHaveAttribute('aria-invalid', 'true');
      const describedBy = reasonField.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy as string)).toHaveTextContent(
        'A reason is required when replacing an existing assignment.',
      );
      expect(screen.getByRole('button', { name: 'Reassign' })).toHaveAccessibleName('Reassign');
    });

    it('gives every end-assignment control an accessible name and wires aria-invalid/aria-describedby on error', async () => {
      mockFetch({ eligible: () => eligibleResponse([]) });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() =>
        expect(screen.getByLabelText('Reason for ending assignment')).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: 'End assignment' }));

      const reasonField = screen.getByLabelText('Reason for ending assignment');
      expect(reasonField).toHaveAttribute('aria-invalid', 'true');
      const describedBy = reasonField.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy as string)).toHaveTextContent(
        'A reason is required when ending an assignment.',
      );
    });

    it('uses role="alert" for errors and role="status" for successful outcomes', async () => {
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }]),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-1' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: null });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.'),
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('D-026 §3 — converted-lead assignment availability', () => {
    it('keeps ADMIN_MANAGER assignment controls fully interactive with no Lead-status input of any kind', async () => {
      // LeadAssignmentPanelProps carries no status field at all, so this
      // panel cannot condition its controls on Lead.status — rendered here
      // exactly as it would be for a CONVERTED_TO_CLIENT Lead: fully
      // interactive assign/reassign/end controls, identical to every other
      // accessible Lead (D-026 §3, a deliberate, binding scope decision).
      mockFetch({
        eligible: () =>
          eligibleResponse([{ id: 'tc-2', name: 'Pedro Reyes', email: 'pedro@example.test' }]),
        mutate: () =>
          jsonResponse(200, { assignment: assignmentRecord({ assignedStaffId: 'tc-2' }) }),
      });
      const user = userEvent.setup();
      renderPanel({ currentAssignment: { staffId: 'tc-1', staffName: 'Maria Santos' } });

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-2');
      expect(screen.getByRole('button', { name: 'Reassign' })).not.toBeDisabled();
      await user.type(
        screen.getByLabelText('Reason for reassignment'),
        'Reassigning after conversion',
      );
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(assignedConsultantSummary()).toHaveTextContent('Pedro Reyes'));
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });
});
