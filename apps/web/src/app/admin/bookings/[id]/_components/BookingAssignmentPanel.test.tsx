// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { BookingAssignmentPanel, type BookingAssignmentSummary } from './BookingAssignmentPanel';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CONSULTANT_A = { id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' };
const CONSULTANT_B = { id: 'tc-2', name: 'Juan Dela Cruz', email: 'juan@example.test' };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function malformedJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

function eligiblePage(
  items: (typeof CONSULTANT_A)[],
  page = 1,
  pageSize = 100,
  total = items.length,
): Response {
  return jsonResponse(200, { items, page, pageSize, total });
}

// Routes a single `fetchMock` between the two endpoints this panel calls:
// `GET /api/assignments/travel-consultants` (no `init`/no `init.method`)
// and `PUT /api/bookings/{bookingId}/assignment` (always has `init.method
// === 'PUT'`). `eligibleQueue` supplies one Response per successive GET
// call (pagination), repeating its last entry if exhausted; `putQueue`
// supplies one Response (or thrown Error) per successive PUT call.
let eligibleQueue: Response[];
let eligibleCallCount: number;
let putQueue: (Response | Error)[];
let putCallCount: number;
let fetchMock: ReturnType<typeof vi.fn>;

function setEligibleQueue(responses: Response[]) {
  eligibleQueue = responses;
  eligibleCallCount = 0;
}

function setPutQueue(responses: (Response | Error)[]) {
  putQueue = responses;
  putCallCount = 0;
}

beforeEach(() => {
  setEligibleQueue([eligiblePage([CONSULTANT_A, CONSULTANT_B])]);
  setPutQueue([]);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const next = putQueue[Math.min(putCallCount, putQueue.length - 1)];
      putCallCount += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }
    const next = eligibleQueue[Math.min(eligibleCallCount, eligibleQueue.length - 1)];
    eligibleCallCount += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);
  pushMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel(
  role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' = 'ADMIN_MANAGER',
  currentAssignment: BookingAssignmentSummary = null,
) {
  return render(
    <BookingAssignmentPanel
      bookingId={BOOKING_ID}
      role={role}
      currentAssignment={currentAssignment}
    />,
  );
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  return form;
}

// The displayed consultant name (e.g. "Maria Santos") also appears as a
// plain-text <option> inside the eligible-consultant <select> whenever the
// interactive ADMIN_MANAGER form is rendered, so a bare `getByText` match
// is ambiguous. This scopes the query to the "Assigned Consultant:"
// summary line specifically.
function getSummaryText(): string {
  return screen.getByText('Assigned Consultant:').closest('p')?.textContent ?? '';
}

async function waitForEligibleLoaded() {
  await waitFor(() => expect(screen.queryByText(/Loading eligible/)).not.toBeInTheDocument());
}

describe('BookingAssignmentPanel', () => {
  describe('TRAVEL_CONSULTANT (read-only)', () => {
    it('renders the current assignment read-only, by staffId (no name resolution attempted)', () => {
      renderPanel('TRAVEL_CONSULTANT', { staffId: 'tc-1' });

      expect(screen.getByText('tc-1')).toBeInTheDocument();
    });

    it('renders an explicit "Unassigned" state when there is no active assignment', () => {
      renderPanel('TRAVEL_CONSULTANT', null);

      expect(screen.getByText('Unassigned')).toBeInTheDocument();
    });

    it('renders no assign, reassign, submit, selection, or reason control', () => {
      renderPanel('TRAVEL_CONSULTANT', { staffId: 'tc-1' });

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
    });

    it('never fetches eligible consultants', async () => {
      renderPanel('TRAVEL_CONSULTANT', { staffId: 'tc-1' });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never issues an assignment PUT request', async () => {
      renderPanel('TRAVEL_CONSULTANT', { staffId: 'tc-1' });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/assignment'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  describe('ADMIN_MANAGER — loading and presentation', () => {
    it('shows accessible loading feedback before eligible consultants resolve', () => {
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      renderPanel('ADMIN_MANAGER', null);

      expect(screen.getByRole('status')).toHaveTextContent('Loading eligible Travel Consultants…');
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('requests the exact eligible-consultant endpoint and query parameters', async () => {
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assignments/travel-consultants?page=1&pageSize=100',
      );
    });

    it('aggregates every page rather than assuming the first response is complete', async () => {
      setEligibleQueue([
        eligiblePage([CONSULTANT_A], 1, 100, 2),
        eligiblePage([CONSULTANT_B], 2, 100, 2),
      ]);
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assignments/travel-consultants?page=1&pageSize=100',
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assignments/travel-consultants?page=2&pageSize=100',
      );
      expect(screen.getByRole('option', { name: 'Maria Santos' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
    });

    it('renders every successfully loaded consultant as a select option', async () => {
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(screen.getByRole('option', { name: 'Maria Santos' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
    });

    it('renders a distinct empty-result message when there are no eligible consultants', async () => {
      setEligibleQueue([eligiblePage([], 1, 100, 0)]);
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(
        screen.getByText('No eligible Travel Consultants are currently available.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('shows a generic error for a malformed consultant-list response, preserving the authoritative current assignment', async () => {
      setEligibleQueue([malformedJsonResponse(200)]);
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });

      await waitForEligibleLoaded();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while loading eligible Travel Consultants. Please check your connection and try again.',
      );
      expect(screen.getByText('tc-1')).toBeInTheDocument();
    });

    it('shows a generic error for a consultant-list server failure', async () => {
      setEligibleQueue([jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } })]);
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while loading eligible Travel Consultants. Please check your connection and try again.',
      );
    });

    it('shows a generic error for a consultant-list network failure', async () => {
      setEligibleQueue([new Error('network down') as unknown as Response]);
      renderPanel('ADMIN_MANAGER', null);

      await waitForEligibleLoaded();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while loading eligible Travel Consultants. Please check your connection and try again.',
      );
    });

    it('does not issue duplicate eligible-consultant requests across rerenders with unchanged props', async () => {
      const { rerender } = renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      rerender(
        <BookingAssignmentPanel
          bookingId={BOOKING_ID}
          role="ADMIN_MANAGER"
          currentAssignment={null}
        />,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves the display name for an already-assigned consultant once the eligible list has loaded', async () => {
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });

      await waitForEligibleLoaded();
      expect(getSummaryText()).toContain('Maria Santos');
    });
  });

  describe('First assignment (no current assignment)', () => {
    it('does not render a reason field', async () => {
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('submits the exact endpoint, method, headers, and a payload with no reason key', async () => {
      setPutQueue([
        jsonResponse(200, {
          assignment: { assignedStaffId: 'tc-1', bookingId: BOOKING_ID, endedAt: null },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe(`/api/bookings/${BOOKING_ID}/assignment`);
      expect(init.method).toBe('PUT');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ assignedStaffId: 'tc-1' });
      expect(Object.keys(body)).not.toContain('reason');
    });

    it('shows an accessible success status and synchronizes to the authoritative response on validated success', async () => {
      setPutQueue([
        jsonResponse(200, {
          assignment: { assignedStaffId: 'tc-2', bookingId: BOOKING_ID, endedAt: null },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.'),
      );
      // Synchronized to the *response's* assignedStaffId (tc-2), not the
      // submitted selection (tc-1) — resolved to its display name.
      expect(getSummaryText()).toContain('Juan Dela Cruz');
    });

    it('calls router.refresh() on success', async () => {
      setPutQueue([
        jsonResponse(200, {
          assignment: { assignedStaffId: 'tc-1', bookingId: BOOKING_ID, endedAt: null },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('Reassignment (an active assignment already exists)', () => {
    it('renders a required reason field', async () => {
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');

      expect(screen.getByLabelText('Reason for reassignment')).toBeRequired();
    });

    it('blocks submission with a blank reason, without calling fetch again', async () => {
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(
        screen.getByText('A reason is required when replacing an existing assignment.'),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial eligible-list GET
    });

    it('blocks submission with a whitespace-only reason', async () => {
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), '   ');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(
        screen.getByText('A reason is required when replacing an existing assignment.'),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('submits the exact reassignment payload including the trimmed reason', async () => {
      setPutQueue([
        jsonResponse(200, {
          assignment: { assignedStaffId: 'tc-2', bookingId: BOOKING_ID, endedAt: null },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(
        screen.getByLabelText('Reason for reassignment'),
        '  Client requested change  ',
      );
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ assignedStaffId: 'tc-2', reason: 'Client requested change' });
    });

    it('blocks a same-assignee (no-op) selection client-side, issuing no PUT request even via a direct form submit', async () => {
      const { container } = renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      fireEvent.change(screen.getByRole('combobox', { name: 'Assign to' }), {
        target: { value: 'tc-1' },
      });

      expect(screen.getByRole('button', { name: 'Reassign' })).toBeDisabled();
      // Fire a raw submit event directly on the form — bypasses the
      // disabled button attribute (which only blocks real user
      // interaction), proving the handler's own no-op guard, not merely
      // the disabled UI, blocks it.
      fireEvent.submit(getForm(container));
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial eligible-list GET
    });

    it('shows an accessible success status and synchronizes to the authoritative response on validated success', async () => {
      setPutQueue([
        jsonResponse(200, {
          assignment: { assignedStaffId: 'tc-2', bookingId: BOOKING_ID, endedAt: null },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Reassigning');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.'),
      );
      expect(getSummaryText()).toContain('Juan Dela Cruz');
    });
  });

  describe('Mutation safety and failures', () => {
    it('prevents a same-batch duplicate submission via a synchronous ref-backed lock (not React state alone)', async () => {
      const putResolvers: Array<(value: Response) => void> = [];
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Promise<Response>((resolve) => {
            putResolvers.push(resolve);
          });
        }
        return Promise.resolve(eligiblePage([CONSULTANT_A, CONSULTANT_B]));
      });
      const { container } = renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      fireEvent.change(screen.getByRole('combobox', { name: 'Assign to' }), {
        target: { value: 'tc-1' },
      });
      const form = getForm(container);

      // Both submit events are dispatched inside a single, synchronous
      // `act` callback — with no `await`/rerender between them — so React
      // never gets a chance to commit `setSubmitting(true)` from the first
      // dispatch before the second dispatch's `handleSubmit` invocation
      // runs. Both invocations therefore close over the exact same
      // pre-update `submitting` state; only an independently mutable ref
      // (mutated synchronously, immediately visible to the very next
      // invocation regardless of render timing) can correctly block the
      // second one here. A state-only guard would let both through.
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      // Exactly one GET (mount) plus one PUT (the first dispatch only).
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(putResolvers).toHaveLength(1);
      const resolveFirstPut = putResolvers[0];
      if (!resolveFirstPut) throw new Error('expected the first PUT resolver to exist');

      await act(async () => {
        resolveFirstPut(
          jsonResponse(200, {
            assignment: { assignedStaffId: 'tc-1', bookingId: BOOKING_ID, endedAt: null },
          }),
        );
        await Promise.resolve();
      });

      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Assignment updated.'),
      );

      // The lock is released once the first request has fully settled: a
      // further, distinct legitimate submission (now a genuine
      // reassignment, since an assignment exists after the first) is not
      // blocked.
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'Follow-up reassignment');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(putResolvers).toHaveLength(2));
      const resolveSecondPut = putResolvers[1];
      if (!resolveSecondPut) throw new Error('expected the second PUT resolver to exist');
      await act(async () => {
        resolveSecondPut(
          jsonResponse(200, {
            assignment: { assignedStaffId: 'tc-2', bookingId: BOOKING_ID, endedAt: null },
          }),
        );
        await Promise.resolve();
      });

      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2));
    });

    it('disables the select and submit button while a mutation is in flight', async () => {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') return new Promise<Response>(() => {});
        return Promise.resolve(eligiblePage([CONSULTANT_A, CONSULTANT_B]));
      });
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      expect(screen.getByRole('combobox', { name: 'Assign to' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    });

    it.each([
      ['ASSIGNEE_NOT_FOUND', 'Assignee not found.'],
      ['ASSIGNEE_INACTIVE', 'This staff account is not active.'],
      ['ASSIGNEE_INELIGIBLE_ROLE', 'This staff member is not an eligible Travel Consultant.'],
      ['ASSIGNMENT_CONFLICT', 'This assignment has changed since it was last loaded.'],
      ['BOOKING_NOT_FOUND', 'Booking not found.'],
    ])('shows the server message for controlled error %s', async (code, message) => {
      setPutQueue([jsonResponse(409, { error: { code, message } })]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    });

    it('shows the REASON_REQUIRED server message inline as a field-level reason error', async () => {
      setPutQueue([
        jsonResponse(409, { error: { code: 'REASON_REQUIRED', message: 'A reason is required.' } }),
      ]);
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'valid reason');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(screen.getByText('A reason is required.')).toBeInTheDocument());
    });

    it('shows a role-forbidden/unauthenticated server message', async () => {
      setPutQueue([
        jsonResponse(401, {
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
        }),
      ]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('Authentication required.'),
      );
    });

    it('shows a generic error for a malformed success response', async () => {
      setPutQueue([malformedJsonResponse(200)]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment. Please check your connection and try again.',
        ),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the exact server-provided message for a well-formed 500 error body', async () => {
      setPutQueue([jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } })]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'));
    });

    it('shows a generic error for a response with a malformed/non-conforming error body', async () => {
      setPutQueue([jsonResponse(500, { unexpected: 'shape' })]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while updating this assignment. Please check your connection and try again.',
        ),
      );
    });

    it('never displays raw exception text or logs anything for a network failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setPutQueue([new Error('ECONNRESET: raw socket failure at internal-host:5432')]);
      renderPanel('ADMIN_MANAGER', null);
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain('ECONNRESET');
      expect(alert.textContent).not.toContain('internal-host');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('preserves the previous authoritative assignment display after a failed mutation', async () => {
      setPutQueue([jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } })]);
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'tc-2');
      await user.type(screen.getByLabelText('Reason for reassignment'), 'attempted change');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      // Still shows the pre-existing assignee (Maria Santos / tc-1), never
      // the failed attempt's target (Juan Dela Cruz / tc-2).
      expect(getSummaryText()).toContain('Maria Santos');
      expect(getSummaryText()).not.toContain('Juan Dela Cruz');
    });

    it('renders no end-assignment or unassign control anywhere', async () => {
      renderPanel('ADMIN_MANAGER', { staffId: 'tc-1' });
      await waitForEligibleLoaded();

      expect(screen.queryByRole('button', { name: /end/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /unassign/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/reason for ending/i)).not.toBeInTheDocument();
    });
  });
});
