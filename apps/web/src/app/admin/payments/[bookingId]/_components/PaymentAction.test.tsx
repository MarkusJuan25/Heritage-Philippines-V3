// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { PaymentAction } from './PaymentAction';

const URL = '/api/payments/3fa85f64-5717-4562-b3fc-2c963f66afa6/reversal';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { payment: { id: 'p-1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function sent(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

function renderReverse() {
  render(
    <PaymentAction
      label="Reverse payment…"
      submitLabel="Reverse payment"
      url={URL}
      withReason
      idempotent
      warning="Reversing cannot be undone."
      successMessage="Payment reversed."
    />,
  );
}

function openAndType(reason: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Reverse payment…' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
}

describe('PaymentAction', () => {
  it('sends nothing until the second, explicit step, and shows the warning there', () => {
    renderReverse();

    expect(screen.queryByText('Reversing cannot be undone.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment…' }));

    expect(screen.getByText('Reversing cannot be undone.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a reason before sending', async () => {
    renderReverse();
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByText('A reason is required.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason with an idempotency key, then refreshes and confirms', async () => {
    renderReverse();
    openAndType('  Duplicate entry  ');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByText('Payment reversed.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'POST' }));
    expect(sent()).toEqual({ reason: 'Duplicate entry', idempotencyKey: expect.any(String) });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('replays the same key when an unchanged request is retried after a failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { payment: { id: 'p-1' } }));
    renderReverse();
    openAndType('Duplicate entry');

    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    await screen.findByText('Payment reversed.');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey);
  });

  it('uses a new key after the request is edited, and after a success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'INVALID_PAYMENT_TRANSITION', message: 'Not confirmed.' },
      }),
    );
    renderReverse();
    openAndType('First reason');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    await screen.findByText('Not confirmed.');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Second reason' } });
    fetchMock.mockResolvedValue(jsonResponse(200, { payment: { id: 'p-1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    await screen.findByText('Payment reversed.');

    openAndType('Third reason');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const keys = [0, 1, 2].map((call) => sent(call).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("shows the server's message for a refusal, keeps the form, and does not refresh", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'BOOKING_STATUS_NOT_PERMITTED', message: 'This booking is cancelled.' },
      }),
    );
    renderReverse();
    openAndType('Duplicate entry');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This booking is cancelled.');
    expect(screen.getByLabelText('Reason')).toHaveValue('Duplicate entry');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a field-level validation error against the reason', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'reason', message: 'reason must be at most 1000 characters' }],
        },
      }),
    );
    renderReverse();
    openAndType('x');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByText('reason must be at most 1000 characters')).toBeInTheDocument();
  });

  it('cancel closes the step without sending', () => {
    renderReverse();
    openAndType('Duplicate entry');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Reverse payment…' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an empty body for an action without a reason or key (receipt, approval)', async () => {
    render(
      <PaymentAction
        label="Issue receipt…"
        submitLabel="Issue receipt"
        url="/api/payments/p-1/receipt"
        successMessage="Receipt issued."
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt' }));

    await screen.findByText('Receipt issued.');
    expect(sent()).toEqual({});
  });

  it('never sends twice for a double submission', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderReverse();
    openAndType('Duplicate entry');
    const submit = screen.getByRole('button', { name: 'Reverse payment' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    resolve(jsonResponse(200, { payment: { id: 'p-1' } }));

    await screen.findByText('Payment reversed.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
