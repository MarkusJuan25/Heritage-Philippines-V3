// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { AmountForm } from './AmountForm';
import { PaymentAction } from './PaymentAction';
import { SectionFeedback } from './SectionFeedback';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const confirmAction = (
  <PaymentAction
    label="Confirm payment…"
    submitLabel="Confirm payment"
    url="/api/payments/p-1/confirmation"
    withReason
    idempotent
    successMessage="Payment confirmed."
  />
);

// After router.refresh(), a confirmed payment renders without its Confirm
// control — the section wrapper itself stays mounted.
const confirmedRow = <p>Status: Confirmed</p>;

async function confirmInside() {
  const view = render(<SectionFeedback>{confirmAction}</SectionFeedback>);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm payment…' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Verified' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm payment' }));
  await screen.findByText('Payment confirmed.');
  return view;
}

describe('SectionFeedback', () => {
  it('keeps a success visible after the action control disappears on refresh', async () => {
    const view = await confirmInside();
    expect(refreshMock).toHaveBeenCalledTimes(1);

    view.rerender(<SectionFeedback>{confirmedRow}</SectionFeedback>);

    expect(screen.queryByRole('button', { name: 'Confirm payment…' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Payment confirmed.');
  });

  it('shows the success once, at the section, not also inside the control', async () => {
    await confirmInside();
    expect(screen.getAllByText('Payment confirmed.')).toHaveLength(1);
  });

  it.each([
    [
      'Approve plan…',
      'Approve plan',
      '/api/payments/plans/x/approval',
      'Payment plan approved.',
      false,
    ],
    [
      'Withdraw plan…',
      'Withdraw plan',
      '/api/payments/plans/x/withdrawal',
      'Payment plan withdrawn.',
      true,
    ],
    ['Issue receipt…', 'Issue receipt', '/api/payments/p-1/receipt', 'Receipt issued.', false],
  ])(
    'keeps "%s" feedback after its control is gone',
    async (label, submit, url, message, withReason) => {
      const view = render(
        <SectionFeedback>
          <PaymentAction
            label={label}
            submitLabel={submit}
            url={url}
            withReason={withReason}
            successMessage={message}
          />
        </SectionFeedback>,
      );
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (withReason) fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'r' } });
      fireEvent.click(screen.getByRole('button', { name: submit }));
      await screen.findByText(message);

      view.rerender(<SectionFeedback>{null}</SectionFeedback>);
      expect(screen.getByRole('status')).toHaveTextContent(message);
    },
  );

  it('clears the previous success when another action is opened, so it never sits next to a new error', async () => {
    const view = await confirmInside();
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: { code: 'INVALID_PAYMENT_TRANSITION', message: 'Not allowed.' } }),
    );
    view.rerender(
      <SectionFeedback>
        <PaymentAction
          label="Reverse payment…"
          submitLabel="Reverse payment"
          url="/api/payments/p-1/reversal"
          withReason
          idempotent
          successMessage="Payment reversed."
        />
      </SectionFeedback>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment…' }));
    expect(screen.queryByText('Payment confirmed.')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps a refund success visible when a full refund removes the refund form', async () => {
    const view = render(
      <SectionFeedback>
        <AmountForm
          title="Refund this payment"
          submitLabel="Record refund"
          url="/api/payments/p-1/refunds"
          withReason
          warning="A refund cannot be undone."
          successMessage="Refund recorded."
          currencyCode="PHP"
        />
      </SectionFeedback>,
    );
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '30000.00' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Cancelled trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Record refund' }));
    await screen.findByText('Refund recorded.');

    view.rerender(<SectionFeedback>{null}</SectionFeedback>);
    expect(screen.getByRole('status')).toHaveTextContent('Refund recorded.');
  });

  it('clears the section success once the user starts editing an amount form', async () => {
    const recordForm = (
      <AmountForm
        title="Record a payment received"
        submitLabel="Record payment"
        url="/api/payments"
        fixed={{ bookingId: 'b-1' }}
        successMessage="Payment recorded as pending."
        currencyCode="PHP"
      />
    );
    render(<SectionFeedback>{recordForm}</SectionFeedback>);
    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByText('Payment recorded as pending.');

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), { target: { value: '5' } });
    expect(screen.queryByText('Payment recorded as pending.')).not.toBeInTheDocument();
  });
});
