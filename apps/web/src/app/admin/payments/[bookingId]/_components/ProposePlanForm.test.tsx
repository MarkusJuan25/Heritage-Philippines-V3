// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { ProposePlanForm } from './ProposePlanForm';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { plan: { id: 'plan-1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function sent() {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
}

function fillRow(index: number, amount: string, dueDate: string) {
  fireEvent.change(screen.getByLabelText(new RegExp(`^Installment ${index} .*amount$`)), {
    target: { value: amount },
  });
  fireEvent.change(screen.getAllByLabelText('Due date')[index - 1]!, {
    target: { value: dueDate },
  });
}

describe('ProposePlanForm', () => {
  it('numbers installments in order, marks only the first as the deposit, and refreshes on success', async () => {
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add installment' }));
    fillRow(1, '35000.00', '2026-10-01');
    fillRow(2, ' 80000.00 ', '2026-11-01');
    fireEvent.click(screen.getByRole('button', { name: 'Propose plan' }));

    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/payments/plans',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(sent()).toEqual({
      bookingId: BOOKING_ID,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '35000.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: false, amount: '80000.00', dueDate: '2026-11-01' },
      ],
    });
  });

  it('sends no deposit when the deposit box is cleared, and renumbers after a removal', async () => {
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add installment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add installment' }));
    fillRow(1, '100.00', '2026-10-01');
    fillRow(2, '200.00', '2026-11-01');
    fillRow(3, '300.00', '2026-12-01');
    fireEvent.click(screen.getByRole('button', { name: 'Remove installment 2' }));
    fireEvent.click(screen.getByLabelText('Installment 1 is the deposit'));
    fireEvent.click(screen.getByRole('button', { name: 'Propose plan' }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().installments).toEqual([
      { sequenceNumber: 1, isDeposit: false, amount: '100.00', dueDate: '2026-10-01' },
      { sequenceNumber: 2, isDeposit: false, amount: '300.00', dueDate: '2026-12-01' },
    ]);
  });

  it("shows the service's field errors against the matching installment row", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [
            { path: 'installments.0.amount', message: 'amount must be a decimal string' },
            { path: 'installments.0.dueDate', message: 'dueDate must be a real calendar date' },
          ],
        },
      }),
    );
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fillRow(1, '35000', '2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: 'Propose plan' }));

    expect(await screen.findByText('amount must be a decimal string')).toBeInTheDocument();
    expect(screen.getByText('dueDate must be a real calendar date')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Installment 1 .*amount$/)).toHaveValue('35000');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a conflict from the service, such as an existing active plan', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'PAYMENT_PLAN_CONFLICT',
          message: 'An active payment plan already exists for this booking.',
        },
      }),
    );
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fillRow(1, '500.00', '2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: 'Propose plan' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An active payment plan already exists for this booking.',
    );
  });

  it('shows a denial from the route', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'BOOKING_FORBIDDEN', message: 'Booking not found or not accessible.' },
      }),
    );
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fillRow(1, '500.00', '2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: 'Propose plan' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Booking not found or not accessible.',
    );
  });

  it('never sends twice for a double submission', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<ProposePlanForm bookingId={BOOKING_ID} currencyCode="PHP" />);
    fillRow(1, '500.00', '2026-10-01');
    const submit = screen.getByRole('button', { name: 'Propose plan' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    resolve(jsonResponse(201, { plan: { id: 'plan-1' } }));

    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
