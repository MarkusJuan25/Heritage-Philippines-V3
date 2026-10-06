import { describe, expect, it } from 'vitest';

import { countInclusiveDays, financeExportRequestSchema } from './export-schemas';

const REFERENCE = 'HPB-0123456789ABCDEF0123';
const DATED_DATASETS = ['payments', 'refunds', 'allocations', 'installments'] as const;

function accepts(input: unknown): boolean {
  return financeExportRequestSchema.safeParse(input).success;
}

describe('financeExportRequestSchema — dataset', () => {
  it('requires a dataset and refuses an unknown one', () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ dataset: 'ledger' })).toBe(false);
    expect(accepts({ dataset: 'bookings' })).toBe(true);
  });

  it('refuses a non-object', () => {
    expect(accepts(null)).toBe(false);
    expect(accepts('bookings')).toBe(false);
  });
});

describe('financeExportRequestSchema — bookings', () => {
  it('accepts an unfiltered export and a booking reference', () => {
    expect(accepts({ dataset: 'bookings' })).toBe(true);
    expect(accepts({ dataset: 'bookings', bookingReference: REFERENCE })).toBe(true);
  });

  it('refuses a date range', () => {
    expect(accepts({ dataset: 'bookings', from: '2026-01-01', to: '2026-01-31' })).toBe(false);
  });

  it('refuses a payment status', () => {
    expect(accepts({ dataset: 'bookings', status: 'CONFIRMED' })).toBe(false);
  });
});

describe.each(DATED_DATASETS)('financeExportRequestSchema — %s', (dataset) => {
  it('refuses a request with neither a date range nor a booking reference', () => {
    expect(accepts({ dataset })).toBe(false);
  });

  it('accepts a date range, a booking reference, or both', () => {
    expect(accepts({ dataset, from: '2026-01-01', to: '2026-01-31' })).toBe(true);
    expect(accepts({ dataset, bookingReference: REFERENCE })).toBe(true);
    expect(
      accepts({ dataset, from: '2026-01-01', to: '2026-01-31', bookingReference: REFERENCE }),
    ).toBe(true);
  });

  it('refuses a range with one end missing, even with a booking reference', () => {
    expect(accepts({ dataset, from: '2026-01-01' })).toBe(false);
    expect(accepts({ dataset, to: '2026-01-31' })).toBe(false);
    expect(accepts({ dataset, from: '2026-01-01', bookingReference: REFERENCE })).toBe(false);
  });

  it('refuses a range whose start is after its end, and accepts a single day', () => {
    expect(accepts({ dataset, from: '2026-02-01', to: '2026-01-31' })).toBe(false);
    expect(accepts({ dataset, from: '2026-01-31', to: '2026-01-31' })).toBe(true);
  });

  it('counts both endpoints: 366 days is accepted and 367 is refused', () => {
    // 2024 is a leap year: 1 January to 31 December is exactly 366 days.
    expect(accepts({ dataset, from: '2024-01-01', to: '2024-12-31' })).toBe(true);
    expect(accepts({ dataset, from: '2024-01-01', to: '2025-01-01' })).toBe(false);
    // 366 days across a non-leap year boundary.
    expect(accepts({ dataset, from: '2025-01-01', to: '2026-01-01' })).toBe(true);
    expect(accepts({ dataset, from: '2025-01-01', to: '2026-01-02' })).toBe(false);
  });

  it('refuses a date that is not a real calendar day in YYYY-MM-DD form', () => {
    expect(accepts({ dataset, from: '2026-02-30', to: '2026-03-01' })).toBe(false);
    expect(accepts({ dataset, from: '2026-1-1', to: '2026-01-31' })).toBe(false);
    expect(accepts({ dataset, from: '01/01/2026', to: '2026-01-31' })).toBe(false);
    expect(accepts({ dataset, from: '2026-01-01T00:00:00Z', to: '2026-01-31' })).toBe(false);
  });

  it('refuses a malformed booking reference', () => {
    expect(accepts({ dataset, bookingReference: 'HPB-123' })).toBe(false);
    expect(accepts({ dataset, bookingReference: REFERENCE.toLowerCase() })).toBe(false);
    expect(accepts({ dataset, bookingReference: `${REFERENCE}' OR 1=1` })).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(accepts({ dataset, bookingReference: REFERENCE, columns: ['amount'] })).toBe(false);
    expect(accepts({ dataset, bookingReference: REFERENCE, bookingId: 'x' })).toBe(false);
  });
});

describe('financeExportRequestSchema — payment status', () => {
  it('is accepted on payments only', () => {
    expect(accepts({ dataset: 'payments', bookingReference: REFERENCE, status: 'CONFIRMED' })).toBe(
      true,
    );
    for (const dataset of ['refunds', 'allocations', 'installments'] as const) {
      expect(accepts({ dataset, bookingReference: REFERENCE, status: 'CONFIRMED' })).toBe(false);
    }
  });

  it('must be an existing PaymentStatus value', () => {
    expect(accepts({ dataset: 'payments', bookingReference: REFERENCE, status: 'PAID' })).toBe(
      false,
    );
    expect(accepts({ dataset: 'payments', bookingReference: REFERENCE, status: 'REFUNDED' })).toBe(
      true,
    );
  });

  it('does not replace the date range or booking reference requirement', () => {
    expect(accepts({ dataset: 'payments', status: 'CONFIRMED' })).toBe(false);
  });
});

describe('countInclusiveDays', () => {
  it('counts both endpoints', () => {
    expect(countInclusiveDays('2026-01-01', '2026-01-01')).toBe(1);
    expect(countInclusiveDays('2026-01-01', '2026-01-02')).toBe(2);
    expect(countInclusiveDays('2024-01-01', '2024-12-31')).toBe(366);
    expect(countInclusiveDays('2025-01-01', '2025-12-31')).toBe(365);
  });
});
