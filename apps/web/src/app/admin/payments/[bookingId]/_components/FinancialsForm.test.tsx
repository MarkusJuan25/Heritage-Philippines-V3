// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { FinancialsForm } from './FinancialsForm';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const URL = `/api/payments/bookings/${BOOKING_ID}/financials`;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { financials: { id: BOOKING_ID } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function sent() {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
}

describe('FinancialsForm — first entry', () => {
  it('has no default currency and requires both fields before sending', async () => {
    render(<FinancialsForm bookingId={BOOKING_ID} currentTotal={null} currentCurrency={null} />);

    expect(screen.getByLabelText('Currency')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));

    expect(await screen.findByText('Enter the booking total.')).toBeInTheDocument();
    expect(screen.getByText('Select the currency.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reason for the change')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers only the supported currencies (currencies-v1: PHP)', () => {
    render(<FinancialsForm bookingId={BOOKING_ID} currentTotal={null} currentCurrency={null} />);

    const options = Array.from(
      (screen.getByLabelText('Currency') as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(['', 'PHP']);
  });

  it('sets both values with PUT and no reason, then refreshes', async () => {
    render(<FinancialsForm bookingId={BOOKING_ID} currentTotal={null} currentCurrency={null} />);
    fireEvent.change(screen.getByLabelText('Booking total'), { target: { value: ' 115000.00 ' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'PHP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));

    expect(await screen.findByText('Booking total saved.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'PUT' }));
    expect(sent()).toEqual({ totalAmount: '115000.00', currencyCode: 'PHP' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('FinancialsForm — correcting values already set', () => {
  function renderSet() {
    render(<FinancialsForm bookingId={BOOKING_ID} currentTotal="11500.00" currentCurrency="PHP" />);
    fireEvent.change(screen.getByLabelText('Booking total'), { target: { value: '115000.00' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'PHP' } });
  }

  it('shows the current values and requires a reason for a change', async () => {
    renderSet();
    expect(screen.getByText(/Currently PHP 11500\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));

    expect(
      await screen.findByText('A reason is required to change the total.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason with the change', async () => {
    renderSet();
    fireEvent.change(screen.getByLabelText('Reason for the change'), {
      target: { value: '  Typo in the first entry  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));

    await screen.findByText('Booking total saved.');
    expect(sent()).toEqual({
      totalAmount: '115000.00',
      currencyCode: 'PHP',
      reason: 'Typo in the first entry',
    });
  });

  it('shows the lock refusal from the service and keeps the input', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'BOOKING_FINANCIALS_LOCKED', message: 'The booking financials are locked.' },
      }),
    );
    renderSet();
    fireEvent.change(screen.getByLabelText('Reason for the change'), {
      target: { value: 'Late fix' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The booking financials are locked.',
    );
    expect(screen.getByLabelText('Booking total')).toHaveValue('115000.00');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('FinancialsForm — refusals and failures', () => {
  function fillFirst(total: string) {
    render(<FinancialsForm bookingId={BOOKING_ID} currentTotal={null} currentCurrency={null} />);
    fireEvent.change(screen.getByLabelText('Booking total'), { target: { value: total } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'PHP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking total' }));
  }

  it('shows a precision error against the total', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [
            {
              path: 'totalAmount',
              message:
                'amount must be a decimal string with exactly two decimal places (e.g. "150.00")',
            },
          ],
        },
      }),
    );
    fillFirst('115000');

    expect(await screen.findByText(/exactly two decimal places/)).toBeInTheDocument();
  });

  it.each([
    ['BOOKING_FORBIDDEN', 403, 'Booking not found or not accessible.'],
    ['BOOKING_STATUS_NOT_PERMITTED', 409, 'This booking is cancelled.'],
  ])('shows %s from the service', async (code, status, message) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: { code, message } }));
    fillFirst('115000.00');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('shows a generic message on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    fillFirst('115000.00');

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });
});
