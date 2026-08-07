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

import type { BookingStatus } from '@/generated/prisma/client';

import { BookingStatusTransitionPanel } from './BookingStatusTransitionPanel';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

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

function renderPanel(
  currentStatus: BookingStatus = 'DRAFT',
  allowedTargetStatuses: BookingStatus[] = ['PENDING_CONFIRMATION', 'CANCELLED'],
) {
  return render(
    <BookingStatusTransitionPanel
      bookingId={BOOKING_ID}
      currentStatus={currentStatus}
      allowedTargetStatuses={allowedTargetStatuses}
    />,
  );
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  return form;
}

async function selectAndSubmit(target: string) {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox', { name: 'New status' }), target);
  await user.click(screen.getByRole('button', { name: 'Update status' }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  pushMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BookingStatusTransitionPanel', () => {
  it('renders only the supplied allowed transitions, and no disallowed status', () => {
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    expect(screen.getByRole('option', { name: 'Pending Confirmation' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Confirmed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'In Preparation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Completed' })).not.toBeInTheDocument();
  });

  it('never independently invents a transition outside the supplied set', () => {
    renderPanel('CONFIRMED', ['IN_PREPARATION', 'CANCELLED']);

    const select = screen.getByRole('combobox', { name: 'New status' });
    const optionValues = Array.from(select.querySelectorAll('option'))
      .map((option) => option.getAttribute('value'))
      .filter((value) => value !== '');
    expect(optionValues).toEqual(['IN_PREPARATION', 'CANCELLED']);
  });

  it('presents CANCELLED as an ordinary supplied option, not a separate control', () => {
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    const select = screen.getByRole('combobox', { name: 'New status' });
    expect(screen.getAllByRole('button')).toHaveLength(1); // only "Update status"
    expect(select.querySelectorAll('option')).toHaveLength(3); // placeholder + 2 targets
  });

  it('renders an accessible read-only message and no mutation control when no transitions are allowed', () => {
    renderPanel('COMPLETED', []);

    expect(
      screen.getByText('No status changes are currently available for this booking.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('submits PUT /api/bookings/{bookingId}/status with the exact method, headers, and payload, using currentStatus as expectedStatus', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/bookings/${BOOKING_ID}/status`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ expectedStatus: 'DRAFT', newStatus: 'PENDING_CONFIRMATION' });
  });

  it('validates the response booking id and status before treating a 200 as success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        booking: { id: 'a-different-booking-id', status: 'PENDING_CONFIRMATION' },
      }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched resulting status even when the booking id matches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'CONFIRMED' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('calls router.refresh() and never router.push() on a validated success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows an accessible success status on a validated 200 response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Status updated to Pending Confirmation.',
      ),
    );
  });

  it('disables the select and submit button while a request is in flight', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    expect(screen.getByRole('combobox', { name: 'New status' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Updating status…' })).toBeDisabled();
  });

  it('prevents a same-batch duplicate submission via a synchronous ref-backed lock (not React state alone)', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { container } = renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    const select = screen.getByRole('combobox', { name: 'New status' });
    fireEvent.change(select, { target: { value: 'PENDING_CONFIRMATION' } });

    const form = getForm(container);
    // Both submit events are dispatched inside a single, synchronous `act`
    // callback — with no `await`/rerender between them — so React never
    // gets a chance to commit `setSubmitting(true)` from the first
    // dispatch before the second dispatch's `handleSubmit` invocation
    // runs. Both invocations close over the exact same pre-update
    // `submitting` state; only the independently mutable `submittingRef`
    // (mutated synchronously) can correctly block the second one here — a
    // state-only guard would let both through, issuing two duplicate,
    // non-idempotent PUT requests.
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    const resolveFirst = resolvers[0];
    if (!resolveFirst) throw new Error('expected the first PUT resolver to exist');
    await act(async () => {
      resolveFirst(
        jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('prevents a duplicate submission after success while currentStatus prop remains the same stale value', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    const { container } = renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('combobox', { name: 'New status' })).toBeDisabled();

    // A stray direct submit during the brief window before the Server
    // Component actually re-renders with fresh data must never issue a
    // second, redundant PUT request.
    fireEvent.submit(getForm(container));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-enables and offers the next valid transitions once rerendered with a different currentStatus, never permanently blocking', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    const { rerender } = renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('combobox', { name: 'New status' })).toBeDisabled();

    // The Server Component reloads and hands this panel a fresh
    // currentStatus plus newly recomputed allowed targets.
    rerender(
      <BookingStatusTransitionPanel
        bookingId={BOOKING_ID}
        currentStatus="PENDING_CONFIRMATION"
        allowedTargetStatuses={['CONFIRMED', 'CANCELLED']}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'New status' })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: 'Confirmed' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'New status' }), 'CONFIRMED');
    await user.click(screen.getByRole('button', { name: 'Update status' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ expectedStatus: 'PENDING_CONFIRMATION', newStatus: 'CONFIRMED' });
  });

  describe('BOOKING_CONFLICT', () => {
    const CONFLICT_MESSAGE =
      'This booking has changed since it was last loaded. Refresh and try again.';

    it('shows the controlled stale-data message and a "Refresh booking" affordance', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { error: { code: 'BOOKING_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

      await selectAndSubmit('PENDING_CONFIRMATION');

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE));
      expect(screen.getByRole('button', { name: 'Refresh booking' })).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('the "Refresh booking" action calls router.refresh() and issues no retry or second fetch', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { error: { code: 'BOOKING_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);
      const user = userEvent.setup();

      await selectAndSubmit('PENDING_CONFIRMATION');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'Refresh booking' }));

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never displays the conflict path as a successful transition', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { error: { code: 'BOOKING_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

      await selectAndSubmit('PENDING_CONFIRMATION');

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(screen.queryByText(/^Status updated to/)).not.toBeInTheDocument();
    });
  });

  it('shows the server message for BOOKING_FORBIDDEN', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'BOOKING_FORBIDDEN', message: 'Booking not found or not accessible.' },
      }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Booking not found or not accessible.'),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server message for BOOKING_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Booking not found.'));
  });

  it('shows the server message for INVALID_STATUS_TRANSITION', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Cannot transition a booking from DRAFT to CONFIRMED.',
        },
      }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Cannot transition a booking from DRAFT to CONFIRMED.',
      ),
    );
  });

  it('shows the server message for a role-forbidden/unauthenticated response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Authentication required.'),
    );
  });

  it('shows a generic message for an unexpected server failure, without leaking the raw error code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred.'),
    );
  });

  it('shows a generic error when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(200));
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while updating this booking status. Please check your connection and try again.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a generic error and never refreshes when the 200 response is missing booking.status (incomplete success)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { booking: { id: BOOKING_ID } }));
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('allows retry after a failed submission', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { booking: { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' } }),
    );
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Update status' })).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Update status' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('never displays raw exception text or logs anything for a network failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNRESET: raw socket failure at internal-host:5432'));
    renderPanel('DRAFT', ['PENDING_CONFIRMATION', 'CANCELLED']);

    await selectAndSubmit('PENDING_CONFIRMATION');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Something went wrong while updating this booking status. Please check your connection and try again.',
    );
    expect(alert.textContent).not.toContain('ECONNRESET');
    expect(alert.textContent).not.toContain('internal-host');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
