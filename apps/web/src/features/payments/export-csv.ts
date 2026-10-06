import type { Prisma } from '@/generated/prisma/client';

// The CSV encoder and cell formatters for basic finance exports (D-061 §4,
// D-062 clause 4). Pure: nothing here reads or writes anything. No
// dependency is used — the format is a few lines
// (.claude/rules/architecture.md).

// Written as an escape on purpose: the character itself is invisible in
// source and an editor can remove it without anyone noticing.
const UTF8_BYTE_ORDER_MARK = '\uFEFF';
const ROW_ENDING = '\r\n';
const PHILIPPINE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

// A spreadsheet treats a cell that begins with one of these as a formula.
const FORMULA_LEADING_CHARACTER = /^[=+\-@\t\r]/;

/** Prefixes a single quote to a cell a spreadsheet would read as a formula. */
export function neutralizeFormulaCell(value: string): string {
  return FORMULA_LEADING_CHARACTER.test(value) ? `'${value}` : value;
}

function encodeCell(value: string): string {
  return `"${neutralizeFormulaCell(value).replaceAll('"', '""')}"`;
}

/**
 * RFC 4180 with every field quoted, CRLF row endings (the last row
 * included), one header row, and a UTF-8 byte-order mark. The formula check
 * is applied to every cell, header cells included, so the protection never
 * depends on which columns are free text. A row whose width differs from
 * the header's is a programming error and throws rather than producing a
 * misaligned file.
 */
export function encodeCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Uint8Array {
  let text = UTF8_BYTE_ORDER_MARK + header.map(encodeCell).join(',') + ROW_ENDING;
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(
        `CSV row has ${row.length} cells but the header has ${header.length} columns.`,
      );
    }
    text += row.map(encodeCell).join(',') + ROW_ENDING;
  }
  return new TextEncoder().encode(text);
}

/**
 * An amount as a string with exactly two decimal places, a full stop, no
 * thousands separator, and no currency symbol — from the exact decimal
 * value, never through a JavaScript `number` (CLAUDE.md §8). This function
 * applies no rule of its own and is not an integrity check: stored amounts
 * are held above zero by the database's `*_amount_positive` constraints,
 * and the derived values that could go negative are checked where the row
 * is shaped (export-rows.ts, D-062 clause 7).
 */
export function formatAmount(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

/**
 * A timestamp in Philippine time with an explicit offset and exactly three
 * fractional digits: `YYYY-MM-DDTHH:MM:SS.sss+08:00` (D-062 clause 4). The
 * Philippines observes no daylight saving, so the offset is constant.
 */
export function formatManilaTimestamp(value: Date): string {
  return `${new Date(value.getTime() + PHILIPPINE_UTC_OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

/** A date-only value (`@db.Date`, read as UTC midnight) as `YYYY-MM-DD`, exactly as stored. */
export function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * D-061 §4's two filename forms. Built only from the dataset name, the
 * format version, the date range if one was given, and `asOf` in whole
 * seconds with the fraction dropped (D-062 clause 4) — never a client name
 * or a booking reference.
 */
export function buildFinanceExportFilename(input: {
  dataset: string;
  formatVersion: string;
  from?: string;
  to?: string;
  asOf: Date;
}): string {
  const generatedAt = `${formatManilaTimestamp(input.asOf).slice(0, 19).replaceAll(/[-:]/g, '')}+0800`;
  const range =
    input.from !== undefined && input.to !== undefined
      ? `${input.from.replaceAll('-', '')}_${input.to.replaceAll('-', '')}`
      : 'all-dates';
  return `heritage-finance-${input.dataset}-${input.formatVersion}-${range}-${generatedAt}.csv`;
}
