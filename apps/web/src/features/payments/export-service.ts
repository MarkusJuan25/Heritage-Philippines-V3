import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import {
  FINANCE_EXPORT_AUDIT_ENTITY_TYPE,
  PAYMENT_AUDIT_ACTIONS,
  sanitizeFinanceExportSnapshot,
} from './audit';
import { PaymentError } from './errors';
import { buildFinanceExportFilename, encodeCsv, formatManilaTimestamp } from './export-csv';
import * as exportRepository from './export-repository';
import type { FinanceExportActor } from './export-repository';
import {
  FINANCE_EXPORT_COLUMNS,
  shapeAllocationRow,
  shapeBookingRow,
  shapeInstallmentRow,
  shapePaymentRow,
  shapeRefundRow,
} from './export-rows';
import {
  FINANCE_EXPORT_FORMAT_VERSION,
  FINANCE_EXPORT_ROW_LIMIT,
  FinanceExportRequestError,
  financeExportRequestSchema,
} from './export-schemas';
import type { FinanceExportDataset, FinanceExportRequest } from './export-schemas';
import { insertAuditLog } from './repository';
import { buildBookingPaymentSummary } from './service';

// Basic finance exports (D-061 Stage 2, as clarified by D-062): one
// dataset per call, read and audited in one transaction. No route and no
// interface exist yet (Stage 3). Use with real client data is not
// authorized (D-061 §9).

/**
 * Repeatable Read, so every row and derived value of one file comes from
 * one snapshot (D-061 §5). `timeout` and `maxWait` are provisional bounds:
 * they cap how long one export may hold a pooled connection and a snapshot,
 * and are no promise that an export of any size finishes within them.
 */
export const FINANCE_EXPORT_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 2_000,
  timeout: 20_000,
} as const;

export type FinanceExportScope = 'ALL_BOOKINGS' | 'ASSIGNED_BOOKINGS';

export type FinanceExportResult = {
  exportId: string;
  dataset: FinanceExportDataset;
  formatVersion: string;
  asOf: Date;
  scope: FinanceExportScope;
  rowCount: number;
  bookingCount: number;
  filename: string;
  content: Uint8Array;
};

function isExportRole(role: string): role is FinanceExportActor['role'] {
  return role === 'ADMIN_MANAGER' || role === 'FINANCE_ACCOUNTING';
}

function exportNotPermitted(): PaymentError {
  return new PaymentError(
    'ROLE_NOT_PERMITTED',
    'This account is not permitted to export finance records.',
  );
}

async function readAndShapeRows(
  tx: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: FinanceExportRequest,
  asOf: string,
): Promise<string[][]> {
  switch (request.dataset) {
    case 'bookings': {
      const records = await exportRepository.findBookingExportRecords(tx, actor, request);
      return records.map((record) =>
        shapeBookingRow(
          {
            summary: buildBookingPaymentSummary(record.data.booking.id, record.data),
            planStatus: record.data.plan?.status ?? null,
            clientFullName: record.clientFullName,
          },
          asOf,
        ),
      );
    }
    case 'payments': {
      const records = await exportRepository.findPaymentExportRecords(tx, actor, request);
      return records.map((record) => shapePaymentRow(record, asOf));
    }
    case 'refunds': {
      const records = await exportRepository.findRefundExportRecords(tx, actor, request);
      return records.map((record) => shapeRefundRow(record, asOf));
    }
    case 'allocations': {
      const records = await exportRepository.findAllocationExportRecords(tx, actor, request);
      return records.map((record) => shapeAllocationRow(record, asOf));
    }
    case 'installments': {
      const records = await exportRepository.findInstallmentExportRecords(tx, actor, request);
      return records.map((record) => shapeInstallmentRow(record, asOf));
    }
    default: {
      const exhaustiveCheck: never = request;
      throw new Error(`Unhandled finance export dataset: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Generates one finance export file (D-061 §8's order of steps):
 *
 * 1. Outside any transaction, the session's role is checked and `input` is
 *    validated against `financeExportRequestSchema` — here, whatever the
 *    caller has already done, so no caller can reach the reads with a
 *    filter the dataset does not take or with a dated dataset unfiltered. A
 *    refusal at this step opens no transaction and writes no entry.
 * 2. One Repeatable Read transaction: (a) its first statement re-reads the
 *    actor's account and reads `asOf` — an actor who is no longer active,
 *    or whose stored role may not export, is refused; (b) the stored role,
 *    not the session's, decides the scope; (c) the rows are counted and an
 *    over-limit request is refused; (d) the rows are read and converted to
 *    text, and an export that meets stored data breaking an invariant of
 *    D-062 clause 7 is refused whole; (e) the audit entry is inserted with
 *    the counts just read.
 * 3. Commit.
 * 4. Only then are the already-converted rows assembled into the file.
 *
 * A refusal or failure inside the transaction leaves no entry and returns
 * no file. A failure after the commit leaves the entry and returns no file:
 * the entry records a committed read for export, not a delivered file
 * (D-062 clause 2). There is no idempotency key and no retry — each
 * successful call is its own export with its own entry (D-061 §8).
 */
export async function generateFinanceExport(
  actor: AuthenticatedUser,
  rawInput: unknown,
): Promise<FinanceExportResult> {
  if (!isExportRole(actor.role)) {
    throw exportNotPermitted();
  }
  const parsed = financeExportRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new FinanceExportRequestError(parsed.error.issues);
  }
  const input: FinanceExportRequest = parsed.data;

  const columns = FINANCE_EXPORT_COLUMNS[input.dataset];
  const from = 'from' in input ? input.from : undefined;
  const to = 'to' in input ? input.to : undefined;

  const committed = await prisma.$transaction(async (tx) => {
    // Must remain the transaction's first statement — see
    // `recheckExportActorAndReadClock`.
    const recheck = await exportRepository.recheckExportActorAndReadClock(tx, actor.id);
    if (!recheck || !recheck.isActive || !isExportRole(recheck.role)) {
      throw exportNotPermitted();
    }
    const exportActor: FinanceExportActor = { id: actor.id, role: recheck.role };
    const scope: FinanceExportScope =
      exportActor.role === 'ADMIN_MANAGER' ? 'ALL_BOOKINGS' : 'ASSIGNED_BOOKINGS';
    const asOfText = formatManilaTimestamp(recheck.asOf);

    const rowCount = await exportRepository.countFinanceExportRows(tx, exportActor, input);
    if (rowCount > FINANCE_EXPORT_ROW_LIMIT) {
      throw new PaymentError(
        'EXPORT_ROW_LIMIT_EXCEEDED',
        `This export would hold more than ${FINANCE_EXPORT_ROW_LIMIT} rows. Narrow the date range or export one booking.`,
      );
    }

    const rows = await readAndShapeRows(tx, exportActor, input, asOfText);
    const bookingReferenceIndex = (columns as readonly string[]).indexOf('bookingReference');
    const bookingCount = new Set(rows.map((row) => row[bookingReferenceIndex])).size;

    const exportId = randomUUID();
    await insertAuditLog(tx, {
      actorId: actor.id,
      action: PAYMENT_AUDIT_ACTIONS.FINANCE_EXPORT_GENERATED,
      entityType: FINANCE_EXPORT_AUDIT_ENTITY_TYPE,
      entityId: exportId,
      afterState: sanitizeFinanceExportSnapshot({
        dataset: input.dataset,
        formatVersion: FINANCE_EXPORT_FORMAT_VERSION,
        from,
        to,
        bookingReference: input.bookingReference,
        status: 'status' in input ? input.status : undefined,
        scope,
        actorRole: exportActor.role,
        rowCount: rows.length,
        bookingCount,
        asOf: asOfText,
      }),
    });

    return { exportId, asOf: recheck.asOf, scope, rows, bookingCount };
  }, FINANCE_EXPORT_TRANSACTION_OPTIONS);

  return {
    exportId: committed.exportId,
    dataset: input.dataset,
    formatVersion: FINANCE_EXPORT_FORMAT_VERSION,
    asOf: committed.asOf,
    scope: committed.scope,
    rowCount: committed.rows.length,
    bookingCount: committed.bookingCount,
    filename: buildFinanceExportFilename({
      dataset: input.dataset,
      formatVersion: FINANCE_EXPORT_FORMAT_VERSION,
      from,
      to,
      asOf: committed.asOf,
    }),
    content: encodeCsv(columns, committed.rows),
  };
}
