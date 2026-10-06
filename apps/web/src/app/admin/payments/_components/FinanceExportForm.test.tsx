// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { FinanceExportForm } from './FinanceExportForm';

const REFERENCE = 'HPB-0123456789ABCDEF0123';
const FILENAME = 'heritage-finance-payments-v1-all-dates-20261006T093000+0800.csv';
const OBJECT_URL = 'blob:https://app.heritage.example/1f0c';
const FAILURE =
  'The export could not be generated. If this keeps happening, contact your administrator.';

function fileResponse(disposition: string | null = `attachment; filename="${FILENAME}"`): Response {
  const headers = new Headers({ 'Content-Type': 'text/csv; charset=utf-8' });
  if (disposition !== null) headers.set('Content-Disposition', disposition);
  return {
    ok: true,
    status: 200,
    headers,
    blob: async () => new Blob(['"a"\r\n'], { type: 'text/csv' }),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string; attached: boolean }[];

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(fileResponse());
  vi.stubGlobal('fetch', fetchMock);
  // jsdom implements neither of these.
  createObjectURL = vi.fn(() => OBJECT_URL);
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({
      href: this.getAttribute('href') ?? '',
      download: this.download,
      attached: document.body.contains(this),
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const dataset = () => screen.getByLabelText('Records to export') as HTMLSelectElement;
const reference = () => screen.getByLabelText(/^Booking reference/) as HTMLInputElement;
const fromInput = () => screen.getByLabelText('From') as HTMLInputElement;
const toInput = () => screen.getByLabelText('To') as HTMLInputElement;
const statusSelect = () => screen.getByLabelText('Payment status') as HTMLSelectElement;
const submit = () => screen.getByRole('button', { name: 'Download CSV' });

function choose(value: string) {
  fireEvent.change(dataset(), { target: { value } });
}

function sent(call = 0): { url: string; init: RequestInit; body: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[call]! as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

async function download() {
  fireEvent.click(submit());
  await waitFor(() => expect(submit()).not.toBeDisabled());
}

describe('FinanceExportForm — fields', () => {
  it('offers the five datasets and starts on bookings with only a booking reference', () => {
    render(<FinanceExportForm />);
    expect([...dataset().options].map((option) => option.value)).toEqual([
      'bookings',
      'payments',
      'refunds',
      'allocations',
      'installments',
    ]);
    expect(dataset().value).toBe('bookings');
    expect(screen.getByLabelText('Booking reference (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Payment status')).not.toBeInTheDocument();
  });

  it.each(['refunds', 'allocations', 'installments'])(
    'shows a date range but no payment status for %s',
    (value) => {
      render(<FinanceExportForm />);
      choose(value);
      expect(fromInput()).toBeInTheDocument();
      expect(toInput()).toBeInTheDocument();
      expect(screen.getByLabelText('Booking reference')).toBeInTheDocument();
      expect(screen.queryByLabelText('Payment status')).not.toBeInTheDocument();
    },
  );

  it('shows a date range and every payment status for payments', () => {
    render(<FinanceExportForm />);
    choose('payments');
    expect(fromInput()).toBeInTheDocument();
    expect([...statusSelect().options].map((option) => option.value)).toEqual([
      '',
      'PENDING',
      'CONFIRMED',
      'REJECTED',
      'CANCELLED',
      'FAILED',
      'REVERSED',
      'REFUNDED',
    ]);
  });

  it('says what each date range is measured on', () => {
    render(<FinanceExportForm />);
    choose('installments');
    expect(screen.getByText(/Filters by installment due date\./)).toBeInTheDocument();
    choose('refunds');
    expect(screen.getByText(/Filters by the date a refund was performed\./)).toBeInTheDocument();
  });
});

describe('FinanceExportForm — request', () => {
  it('posts JSON to the export route with only the dataset when nothing else is filled in', async () => {
    render(<FinanceExportForm />);
    await download();
    const request = sent();
    expect(request.url).toBe('/api/payments/exports');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(request.body).toEqual({ dataset: 'bookings' });
  });

  it('sends every filter payments takes, trimmed', async () => {
    render(<FinanceExportForm />);
    choose('payments');
    fireEvent.change(fromInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(toInput(), { target: { value: '2026-09-30' } });
    fireEvent.change(reference(), { target: { value: `  ${REFERENCE} ` } });
    fireEvent.change(statusSelect(), { target: { value: 'CONFIRMED' } });
    await download();
    expect(sent().body).toEqual({
      dataset: 'payments',
      from: '2026-09-01',
      to: '2026-09-30',
      bookingReference: REFERENCE,
      status: 'CONFIRMED',
    });
  });

  it('never sends a filter the chosen dataset does not take, even if it was filled in earlier', async () => {
    render(<FinanceExportForm />);
    choose('payments');
    fireEvent.change(fromInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(toInput(), { target: { value: '2026-09-30' } });
    fireEvent.change(statusSelect(), { target: { value: 'CONFIRMED' } });

    choose('refunds');
    await download();
    expect(sent(0).body).toEqual({ dataset: 'refunds', from: '2026-09-01', to: '2026-09-30' });

    choose('bookings');
    await download();
    expect(sent(1).body).toEqual({ dataset: 'bookings' });
  });

  it('ignores a second submit while one is in flight', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    render(<FinanceExportForm />);
    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preparing export…' })).toBeDisabled(),
    );
    fireEvent.submit(screen.getByRole('button', { name: 'Preparing export…' }).closest('form')!);
    finish(fileResponse());
    await waitFor(() => expect(submit()).not.toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FinanceExportForm — checks before sending', () => {
  it.each([
    ['only a start date', { from: '2026-09-01' }, 'Enter the end of the date range.'],
    ['only an end date', { to: '2026-09-30' }, 'Enter the start of the date range.'],
    ['neither a range nor a reference', {}, 'Enter a date range, a booking reference, or both.'],
    [
      'a start after the end',
      { from: '2026-10-01', to: '2026-09-30' },
      'The start date must not be after the end date.',
    ],
  ])('does not send a dated export with %s', async (_label, values, message) => {
    render(<FinanceExportForm />);
    choose('refunds');
    if ('from' in values) fireEvent.change(fromInput(), { target: { value: values.from } });
    if ('to' in values) fireEvent.change(toInput(), { target: { value: values.to } });
    fireEvent.click(submit());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check the highlighted fields and try again.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // What was typed is still there.
    expect(fromInput().value).toBe('from' in values ? values.from : '');
    expect(toInput().value).toBe('to' in values ? values.to : '');
  });

  it('sends a dated export that has a booking reference and no range', async () => {
    render(<FinanceExportForm />);
    choose('allocations');
    fireEvent.change(reference(), { target: { value: REFERENCE } });
    await download();
    expect(sent().body).toEqual({ dataset: 'allocations', bookingReference: REFERENCE });
  });
});

describe('FinanceExportForm — download', () => {
  it("saves the file under the server's filename and releases the object URL", async () => {
    render(<FinanceExportForm />);
    choose('payments');
    fireEvent.change(reference(), { target: { value: REFERENCE } });
    await download();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(clicked).toEqual([{ href: OBJECT_URL, download: FILENAME, attached: true }]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
    // The temporary link is gone.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(`Export downloaded: ${FILENAME}`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('releases the object URL and removes the link even when the click throws', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click blocked');
    });
    render(<FinanceExportForm />);
    await download();

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
    expect(document.querySelector('a[download]')).toBeNull();
    // Reported as a failure, never as a completed download.
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([
    ['no Content-Disposition', null],
    ['an inline disposition', `inline; filename="${FILENAME}"`],
    ['a filename with a path', 'attachment; filename="../../etc/passwd.csv"'],
    ['a filename that is not a CSV', 'attachment; filename="export.html"'],
    ['an unquoted filename', `attachment; filename=${FILENAME}`],
  ])('does not save a file when the response has %s', async (_label, disposition) => {
    fetchMock.mockResolvedValue(fileResponse(disposition));
    render(<FinanceExportForm />);
    await download();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE);
  });

  it('clears the downloaded note when the form is edited', async () => {
    render(<FinanceExportForm />);
    await download();
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.change(reference(), { target: { value: 'H' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('FinanceExportForm — errors keep what was entered', () => {
  function fillPayments() {
    choose('payments');
    fireEvent.change(fromInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(toInput(), { target: { value: '2026-09-30' } });
    fireEvent.change(reference(), { target: { value: REFERENCE } });
    fireEvent.change(statusSelect(), { target: { value: 'REFUNDED' } });
  }

  function expectInputsKept() {
    expect(dataset().value).toBe('payments');
    expect(fromInput().value).toBe('2026-09-01');
    expect(toInput().value).toBe('2026-09-30');
    expect(reference().value).toBe(REFERENCE);
    expect(statusSelect().value).toBe('REFUNDED');
  }

  it('shows field-level messages from the 400 envelope beside their fields', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [
            { path: 'to', message: 'A date range may cover at most 366 days.' },
            {
              path: 'bookingReference',
              message: 'bookingReference is not a valid booking reference',
            },
          ],
        },
      }),
    );
    render(<FinanceExportForm />);
    fillPayments();
    await download();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check the highlighted fields and try again.',
    );
    expect(toInput()).toHaveAccessibleDescription('A date range may cover at most 366 days.');
    expect(toInput()).toHaveAttribute('aria-invalid', 'true');
    expect(reference()).toHaveAccessibleDescription(
      'bookingReference is not a valid booking reference',
    );
    expect(fromInput()).not.toHaveAttribute('aria-invalid');
    expectInputsKept();
    expect(clicked).toEqual([]);
  });

  it('asks the user to narrow the filters payments permits on 422', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, {
        error: { code: 'EXPORT_ROW_LIMIT_EXCEEDED', message: 'server wording' },
      }),
    );
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This export has too many rows to download at once. Choose a shorter date range, enter a booking reference, or pick a payment status, then try again.',
    );
    expectInputsKept();
  });

  it('names only the booking reference for a bookings export on 422', async () => {
    fetchMock.mockResolvedValue(errorResponse(422, { error: { code: 'X', message: 'x' } }));
    render(<FinanceExportForm />);
    await download();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This export has too many rows to download at once. Enter a booking reference to export one booking.',
    );
  });

  it('says only that the export could not be generated on 500, with no detail', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message:
            'Finance export refused: stored data failed the integrity check for payments.derivedUnallocated.',
        },
      }),
    );
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(FAILURE);
    expect(alert.textContent).toBe(FAILURE);
    expect(document.body.textContent).not.toMatch(/integrity|derivedUnallocated|stored data/);
    expectInputsKept();
  });

  it.each([
    [401, 'Your session has ended. Sign in again, then retry the export.'],
    [
      403,
      'This export request was not permitted. If this keeps happening, contact your administrator.',
    ],
    [415, FAILURE],
    [502, FAILURE],
  ])('shows fixed wording for %i', async (status, message) => {
    fetchMock.mockResolvedValue(
      errorResponse(status, { error: { code: 'ANY', message: 'server wording not shown' } }),
    );
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(document.body.textContent).not.toContain('server wording not shown');
    expectInputsKept();
  });

  it('reports a network failure and keeps the inputs', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The export could not be requested. Check your connection and try again.',
    );
    expectInputsKept();
  });

  it.each([
    ['is not the expected envelope', 'not json at all'],
    ['has no field details', { error: { code: 'VALIDATION_ERROR', message: 'x' } }],
    [
      'names only a field this form is not showing',
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'x',
          details: [{ path: 'columns', message: 'y' }],
        },
      },
    ],
  ])('does not point at highlighted fields when a 400 %s', async (_label, body) => {
    fetchMock.mockResolvedValue(errorResponse(400, body));
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    expect(screen.getByRole('alert').textContent).toBe(
      'The export request was not accepted. Check the filters and try again.',
    );
    expectInputsKept();
  });

  it('clears an error when the form is edited and retries cleanly', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, {}));
    render(<FinanceExportForm />);
    fillPayments();
    await download();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(statusSelect(), { target: { value: 'CONFIRMED' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await download();
    expect(clicked).toHaveLength(1);
    expect(sent(1).body.status).toBe('CONFIRMED');
  });
});
