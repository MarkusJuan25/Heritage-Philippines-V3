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

import { CreateBookingButton } from './CreateBookingButton';

const PROPOSAL_VERSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BOOKING_ID = 'b1b2c3d4-0000-4000-8000-000000000002';

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while creating this booking. Please check your connection and try again.';

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

function bookingSuccess(
  status: 200 | 201,
  overrides: Partial<{ id: string; proposalVersionId: string }> = {},
): Response {
  return jsonResponse(status, {
    booking: { id: BOOKING_ID, proposalVersionId: PROPOSAL_VERSION_ID, ...overrides },
  });
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

function renderButton(proposalVersionId = PROPOSAL_VERSION_ID) {
  return render(<CreateBookingButton proposalVersionId={proposalVersionId} />);
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  return form;
}

describe('CreateBookingButton', () => {
  it('submits the exact endpoint, method, headers, and a payload containing only proposalVersionId', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bookings');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ proposalVersionId: PROPOSAL_VERSION_ID });
    expect(Object.keys(body)).toEqual(['proposalVersionId']);
  });

  it('uses the exact provided proposalVersionId in the request', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    const distinctId = 'c1b2c3d4-0000-4000-8000-000000000003';
    renderButton(distinctId);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.proposalVersionId).toBe(distinctId);
  });

  it('treats a 201 (newly created) response as success', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/admin/bookings/${BOOKING_ID}`));
  });

  it('treats a 200 (idempotent replay) response as success', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(200));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/admin/bookings/${BOOKING_ID}`));
  });

  it('navigates to the authoritative returned Booking id, never a fabricated one', async () => {
    const otherBookingId = 'd1b2c3d4-0000-4000-8000-000000000004';
    fetchMock.mockResolvedValue(bookingSuccess(200, { id: otherBookingId }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/admin/bookings/${otherBookingId}`));
  });

  it('rejects a malformed booking object (missing id) and does not navigate', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { booking: { proposalVersionId: PROPOSAL_VERSION_ID } }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(GENERIC_ERROR_MESSAGE));
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects an empty-string booking id and does not navigate', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201, { id: '   ' }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('rejects an identity-mismatched proposalVersionId and does not navigate', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201, { proposalVersionId: 'different-version-id' }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized 2xx status as non-success, even with an otherwise well-formed body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(202, { booking: { id: BOOKING_ID, proposalVersionId: PROPOSAL_VERSION_ID } }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(GENERIC_ERROR_MESSAGE));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('calls router.push before router.refresh, in that order', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    const pushOrder = pushMock.mock.invocationCallOrder[0];
    const refreshOrder = refreshMock.mock.invocationCallOrder[0];
    expect(pushOrder).toBeDefined();
    expect(refreshOrder).toBeDefined();
    expect(pushOrder as number).toBeLessThan(refreshOrder as number);
  });

  it('never navigates before the response has been validated', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is pending', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    expect(screen.getByRole('button', { name: 'Creating Booking…' })).toBeDisabled();
  });

  it('shows an accessible success status on validated success', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Booking created. Redirecting…'),
    );
  });

  it('keeps the submit button disabled after success, while navigation is pending', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create Booking' })).toBeDisabled();
  });

  it('prevents a same-batch duplicate submission via a synchronous ref-backed lock (not React state alone)', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { container } = renderButton();
    const form = getForm(container);

    // Both submit events are dispatched inside a single, synchronous `act`
    // callback — with no `await`/rerender between them — so React never
    // gets a chance to commit `setSubmitting(true)` from the first
    // dispatch before the second dispatch's `handleSubmit` invocation
    // runs. Both invocations close over the exact same pre-update
    // `submitting` state; only the independently mutable `submittingRef`
    // (mutated synchronously) can correctly block the second one here.
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    const resolveFirst = resolvers[0];
    if (!resolveFirst) throw new Error('expected the first POST resolver to exist');
    await act(async () => {
      resolveFirst(bookingSuccess(201));
      await Promise.resolve();
    });

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });

  it('permanently prevents any further submission after a validated success', async () => {
    fetchMock.mockResolvedValue(bookingSuccess(201));
    const { container } = renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A stray direct form submit after success (simulating the brief
    // window before navigation actually unmounts this component) must not
    // issue a second POST — proving the permanent latch, not merely the
    // disabled button attribute, blocks it.
    fireEvent.submit(getForm(container));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('releases the temporary lock after a controlled failure, allowing a legitimate retry', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'PROPOSAL_VERSION_NOT_ACCEPTED',
            message: 'This version has not been accepted.',
          },
        }),
      )
      .mockResolvedValueOnce(bookingSuccess(201));
    renderButton();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the temporary lock after a malformed success response, allowing a legitimate retry', async () => {
    fetchMock
      .mockResolvedValueOnce(malformedJsonResponse(201))
      .mockResolvedValueOnce(bookingSuccess(201));
    renderButton();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the temporary lock after a network failure, allowing a legitimate retry', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(bookingSuccess(201));
    renderButton();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Booking' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['PROPOSAL_VERSION_NOT_ACCEPTED', 'This version has not been accepted.'],
    ['PROPOSAL_VERSION_FORBIDDEN', 'This proposal version is not accessible to you.'],
    ['PROPOSAL_VERSION_NOT_FOUND', 'Proposal version not found.'],
    ['ROLE_NOT_PERMITTED', 'You are not permitted to create bookings.'],
  ])('shows the server message for controlled error %s', async (code, message) => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code, message } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
  });

  it('shows a role-forbidden/unauthenticated server message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Authentication required.'),
    );
  });

  it('shows a generic error for a response with a malformed/non-conforming error body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { unexpected: 'shape' }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(GENERIC_ERROR_MESSAGE));
  });

  it('shows the exact server-provided message for a well-formed generic server error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'));
  });

  it('shows a generic error and never logs anything for a network failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNRESET: raw socket failure at internal-host:5432'));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Booking' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('ECONNRESET');
    expect(alert.textContent).not.toContain('internal-host');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
