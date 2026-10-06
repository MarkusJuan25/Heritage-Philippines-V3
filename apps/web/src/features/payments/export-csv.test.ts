import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  buildFinanceExportFilename,
  encodeCsv,
  formatAmount,
  formatDateOnly,
  formatManilaTimestamp,
  neutralizeFormulaCell,
} from './export-csv';

/**
 * A minimal RFC 4180 reader, independent of the encoder under test: quoted
 * fields, doubled quotes, and commas and line breaks inside quotes.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else {
      field += character;
    }
  }
  return rows;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

describe('encodeCsv', () => {
  it('starts with a UTF-8 byte-order mark', () => {
    const bytes = encodeCsv(['a'], []);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('quotes every field, ends every row with CRLF, and writes one header row', () => {
    const text = decode(
      encodeCsv(
        ['a', 'b'],
        [
          ['1', ''],
          ['x', 'y'],
        ],
      ),
    );
    expect(text).toBe('\uFEFF"a","b"\r\n"1",""\r\n"x","y"\r\n');
  });

  it('writes only the header row when there are no rows', () => {
    expect(decode(encodeCsv(['a', 'b'], []))).toBe('\uFEFF"a","b"\r\n');
  });

  it('doubles embedded double quotes', () => {
    expect(decode(encodeCsv(['a'], [['say "hi"']]))).toBe('\uFEFF"a"\r\n"say ""hi"""\r\n');
  });

  it.each([
    ['=', '=SUM(A1:A9)'],
    ['+', '+639171234567'],
    ['-', '-1+1'],
    ['@', '@handle'],
    ['tab', '\tindented'],
    ['carriage return', '\rreturned'],
  ])('prefixes a cell beginning with %s and round-trips it', (_label, value) => {
    const rows = parseCsv(decode(encodeCsv(['name'], [[value]])).slice(1));
    expect(rows).toEqual([['name'], [`'${value}`]]);
  });

  it.each([
    ['a comma', 'Dela Cruz, Juan'],
    ['a double quote', 'Juan "Jun" Dela Cruz'],
    ['a line break', 'Juan\nDela Cruz'],
    ['a CRLF', 'Juan\r\nDela Cruz'],
    ['non-ASCII characters', 'Niño Peñaflorida 日本語'],
    ['a formula character that is not first', 'A=B'],
  ])('round-trips a name containing %s unchanged', (_label, value) => {
    const rows = parseCsv(decode(encodeCsv(['name', 'other'], [[value, 'x']])).slice(1));
    expect(rows).toEqual([
      ['name', 'other'],
      [value, 'x'],
    ]);
  });

  it('encodes non-ASCII text as UTF-8 bytes', () => {
    const bytes = encodeCsv(['n'], [['ñ']]);
    expect([...bytes]).toContain(0xc3);
    expect([...bytes]).toContain(0xb1);
  });

  it('refuses a row whose width differs from the header', () => {
    expect(() => encodeCsv(['a', 'b'], [['only one']])).toThrow(/1 cells .* 2 columns/);
  });
});

describe('neutralizeFormulaCell', () => {
  it('leaves an ordinary cell and an empty cell unchanged', () => {
    expect(neutralizeFormulaCell('Juan Dela Cruz')).toBe('Juan Dela Cruz');
    expect(neutralizeFormulaCell('')).toBe('');
    expect(neutralizeFormulaCell('1500.00')).toBe('1500.00');
  });
});

describe('formatAmount', () => {
  it.each([
    ['0', '0.00'],
    ['0.00', '0.00'],
    ['150', '150.00'],
    ['150.5', '150.50'],
    ['1234567.89', '1234567.89'],
    // The largest value a Decimal(18, 2) column can hold.
    ['9999999999999999.99', '9999999999999999.99'],
  ])('writes %s as %s', (input, expected) => {
    expect(formatAmount(new Prisma.Decimal(input))).toBe(expected);
  });

  it('writes no thousands separator, currency symbol, or exponent', () => {
    expect(formatAmount(new Prisma.Decimal('1e15'))).toBe('1000000000000000.00');
  });

  it('applies no rule of its own, and the encoder prefixes a cell beginning with a minus sign', () => {
    // formatAmount is a formatter, not an integrity check: the derived
    // values that could go negative are checked where rows are shaped
    // (D-062 clause 7), so no negative amount reaches a file. The encoder's
    // formula protection is independent of that and still applies.
    expect(formatAmount(new Prisma.Decimal('-0.01'))).toBe('-0.01');
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      encodeCsv(['derivedUnallocated'], [[formatAmount(new Prisma.Decimal('-50'))]]),
    );
    expect(text).toBe('\uFEFF"derivedUnallocated"\r\n"\'-50.00"\r\n');
  });
});

describe('formatManilaTimestamp', () => {
  it('writes Philippine time with an explicit offset and three fractional digits', () => {
    expect(formatManilaTimestamp(new Date('2026-10-05T06:30:00.000Z'))).toBe(
      '2026-10-05T14:30:00.000+08:00',
    );
    expect(formatManilaTimestamp(new Date('2026-10-05T06:30:00.007Z'))).toBe(
      '2026-10-05T14:30:00.007+08:00',
    );
  });

  it('moves to the next Philippine calendar day for a late UTC time', () => {
    expect(formatManilaTimestamp(new Date('2026-12-31T16:00:00.000Z'))).toBe(
      '2027-01-01T00:00:00.000+08:00',
    );
  });
});

describe('formatDateOnly', () => {
  it('writes a date-only value exactly as stored', () => {
    expect(formatDateOnly(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
  });
});

describe('buildFinanceExportFilename', () => {
  const asOf = new Date('2026-10-05T06:30:15.999Z');

  it('uses the dated form when a range was given', () => {
    expect(
      buildFinanceExportFilename({
        dataset: 'payments',
        formatVersion: 'v1',
        from: '2026-01-01',
        to: '2026-03-31',
        asOf,
      }),
    ).toBe('heritage-finance-payments-v1-20260101_20260331-20261005T143015+0800.csv');
  });

  it('uses the all-dates form otherwise, dropping the fraction of asOf', () => {
    expect(buildFinanceExportFilename({ dataset: 'bookings', formatVersion: 'v1', asOf })).toBe(
      'heritage-finance-bookings-v1-all-dates-20261005T143015+0800.csv',
    );
  });
});
