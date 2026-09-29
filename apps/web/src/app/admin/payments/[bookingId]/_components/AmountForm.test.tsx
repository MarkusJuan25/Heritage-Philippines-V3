// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { AmountForm } from './AmountForm';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { payment: { id: 'p-1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function sent(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

function renderRecord() {
  render(
    <AmountForm
      title="Record a payment received"
      submitLabel="Record payment"
      url="/api/payments"
      fixed={{ bookingId: BOOKING_ID }}
      successMessage="Payment recorded as pending."
      currencyCode="PHP"
    />,
  );
}

function renderRefund() {
  render(
    <AmountForm
      title="Refund this payment"
      submitLabel="Record refund"
      url="/api/payments/p-1/refunds"
      selects={[
        {
          name: 'allocationId',
          label: 'Reduce allocation',
          optionalLabel: 'None — refund unapplied credit',
          options: [{ value: 'alloc-1', label: 'Installment 1: PHP 100.00' }],
        },
      ]}
      withReason
      warning="A refund cannot be undone."
      successMessage="Refund recorded."
      currencyCode="PHP"
    />,
  );
}

describe('AmountForm — recording a payment', () => {
  it('sends the fixed Booking id, the trimmed amount, and an idempotency key', async () => {
    renderRecord();
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: ' 35000.00 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText('Payment recorded as pending.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/payments',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(sent()).toEqual({
      bookingId: BOOKING_ID,
      amount: '35000.00',
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByLabelText('Amount (PHP)')).toHaveValue('');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('replays the same key after a failed attempt, so a payment that did arrive is never recorded twice', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(201, { payment: { id: 'p-1' } }));
    renderRecord();
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '100.00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (PHP)')).toHaveValue('100.00');
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText('Payment recorded as pending.');

    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey);
  });

  it('issues a new key once the amount changes, and after a success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'This key was used for a different request.',
        },
      }),
    );
    renderRecord();
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText('This key was used for a different request.');

    fetchMock.mockResolvedValue(jsonResponse(201, { payment: { id: 'p-1' } }));
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '150.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText('Payment recorded as pending.');

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '150.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText('Payment recorded as pending.');

    const keys = [0, 1, 2].map((call) => sent(call).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("shows the service's refusal and a field error against the amount", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'amount', message: 'amount must be greater than zero' }],
        },
      }),
    );
    renderRecord();
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '0.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText('amount must be greater than zero')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The request did not pass validation.');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('AmountForm — refunding (irreversible, with a confirmation step)', () => {
  function fill() {
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '50.00' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Excursion cancelled' } });
  }

  it('asks for confirmation on the first submit and sends only on the second', async () => {
    renderRefund();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));

    expect(screen.getByText('A refund cannot be undone.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse(200, { refund: { id: 'r-1' }, payment: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Record refund' }));
    await screen.findByText('Refund recorded.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits the optional allocation when "none" is kept, and sends it when chosen', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { refund: { id: 'r-1' }, payment: {} }));
    renderRefund();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Record refund' }));
    await screen.findByText('Refund recorded.');
    expect(sent(0)).toEqual({
      amount: '50.00',
      reason: 'Excursion cancelled',
      idempotencyKey: expect.any(String),
    });

    fireEvent.change(screen.getByLabelText('Reduce allocation'), { target: { value: 'alloc-1' } });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Record refund' }));
    await screen.findByText('Refund recorded.');
    expect(sent(1)).toEqual(expect.objectContaining({ allocationId: 'alloc-1' }));
  });

  it('editing after asking for confirmation withdraws the confirmation', () => {
    renderRefund();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '60.00' } });

    expect(screen.queryByText('A refund cannot be undone.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record refund' })).toBeInTheDocument();
  });

  it('shows REFUND_EXCEEDS_REMAINING from the service', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'REFUND_EXCEEDS_REMAINING',
          message: 'This refund exceeds the remaining amount.',
        },
      }),
    );
    renderRefund();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Record refund' }));

    expect(
      await screen.findByText('This refund exceeds the remaining amount.'),
    ).toBeInTheDocument();
  });
});
