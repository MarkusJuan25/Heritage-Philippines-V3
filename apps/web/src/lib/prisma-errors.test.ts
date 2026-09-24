import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  isResidualDatabaseConflict,
  isRetryableWriteConflict,
  isSerializableRetriesExhausted,
  isUniqueViolationOn,
  SerializableRetriesExhaustedError,
  uniqueViolation,
} from './prisma-errors';

// Every fixture below reproduces an error shape observed directly from
// `@prisma/adapter-pg` 7.8.0 against a real PostgreSQL database (see
// lib/prisma-errors.ts and prisma-errors.integration.test.ts, which
// produces the same shapes for real).

/** The raw form Prisma surfaces when Postgres detects 40001 at COMMIT. */
function rawAdapterWriteConflict(): Error {
  const error = new Error('TransactionWriteConflict');
  error.name = 'DriverAdapterError';
  (error as Error & { cause: unknown }).cause = {
    originalCode: '40001',
    originalMessage: 'could not serialize access due to read/write dependencies among transactions',
    kind: 'TransactionWriteConflict',
  };
  return error;
}

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('Simulated', {
    code,
    clientVersion: '7.8.0',
    meta,
  });
}

/** A P2002 exactly as the adapter reports it: no `meta.target`. */
function adapterUniqueViolation(modelName: string, rawFields: string[]) {
  return knownError('P2002', {
    modelName,
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        kind: 'UniqueConstraintViolation',
        constraint: { fields: rawFields },
      },
    },
  });
}

describe('isRetryableWriteConflict', () => {
  it('recognizes the statement-time form: P2034', () => {
    expect(isRetryableWriteConflict(knownError('P2034'))).toBe(true);
  });

  it('recognizes the commit-time form: a raw DriverAdapterError with kind TransactionWriteConflict', () => {
    expect(isRetryableWriteConflict(rawAdapterWriteConflict())).toBe(true);
  });

  it.each([
    ['a unique violation', adapterUniqueViolation('ClientProfile', ['"userId"'])],
    ['a CHECK violation', knownError('P2004')],
    ['a plain Error', new Error('boom')],
    [
      'a DriverAdapterError of another kind',
      Object.assign(new Error('x'), {
        name: 'DriverAdapterError',
        cause: { kind: 'UniqueConstraintViolation' },
      }),
    ],
    [
      'an Error merely named DriverAdapterError with no cause',
      Object.assign(new Error('x'), {
        name: 'DriverAdapterError',
      }),
    ],
    ['undefined', undefined],
  ])('does not treat %s as retryable', (_label, error) => {
    expect(isRetryableWriteConflict(error)).toBe(false);
  });
});

describe('SerializableRetriesExhaustedError', () => {
  it('records the attempt count, keeps the last conflict only as cause, and exposes no database detail in its message', () => {
    const cause = rawAdapterWriteConflict();
    const error = new SerializableRetriesExhaustedError(3, cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SerializableRetriesExhaustedError');
    expect(error.attempts).toBe(3);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toMatch(/serialize|40001|TransactionWriteConflict/);
    expect(isSerializableRetriesExhausted(error)).toBe(true);
    expect(isSerializableRetriesExhausted(cause)).toBe(false);
  });
});

describe('uniqueViolation', () => {
  it('unquotes a mixed-case column exactly as Postgres quotes it', () => {
    expect(uniqueViolation(adapterUniqueViolation('ClientProfile', ['"userId"']))).toEqual({
      modelName: 'ClientProfile',
      fields: ['userId'],
    });
  });

  it('leaves an unquoted lower-case column as-is and handles composite keys', () => {
    expect(
      uniqueViolation(
        adapterUniqueViolation('ProposalVersion', ['"proposalId"', '"versionNumber"']),
      ),
    ).toEqual({ modelName: 'ProposalVersion', fields: ['proposalId', 'versionNumber'] });
    expect(uniqueViolation(adapterUniqueViolation('User', ['email']))?.fields).toEqual(['email']);
  });

  it('undoes a doubled embedded quote', () => {
    expect(uniqueViolation(adapterUniqueViolation('M', ['"a""b"']))?.fields).toEqual(['a"b']);
  });

  it('reports no fields when the adapter names only the index', () => {
    const error = knownError('P2002', {
      modelName: 'ProposalVersion',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'some_key' } },
      },
    });
    expect(uniqueViolation(error)).toEqual({ modelName: 'ProposalVersion', fields: [] });
  });

  it('falls back to a legacy meta.target only when the adapter shape is absent', () => {
    expect(uniqueViolation(knownError('P2002', { target: ['email'] }))).toEqual({
      modelName: null,
      fields: ['email'],
    });
  });

  it('returns null for anything that is not a P2002', () => {
    expect(uniqueViolation(knownError('P2034'))).toBeNull();
    expect(uniqueViolation(rawAdapterWriteConflict())).toBeNull();
    expect(uniqueViolation(new Error('x'))).toBeNull();
  });
});

describe('isUniqueViolationOn', () => {
  const composite = adapterUniqueViolation('ProposalVersion', ['"proposalId"', '"versionNumber"']);

  it('matches the exact model and exact field set, in any order', () => {
    expect(isUniqueViolationOn(composite, 'ProposalVersion', ['versionNumber', 'proposalId'])).toBe(
      true,
    );
  });

  it('never matches a different model with the same column name', () => {
    const onBooking = adapterUniqueViolation('Booking', ['"proposalVersionId"']);
    expect(isUniqueViolationOn(onBooking, 'ProposalAcceptance', ['proposalVersionId'])).toBe(false);
    expect(isUniqueViolationOn(onBooking, 'Booking', ['proposalVersionId'])).toBe(true);
  });

  it('never matches a subset or superset of the violated columns', () => {
    expect(isUniqueViolationOn(composite, 'ProposalVersion', ['proposalId'])).toBe(false);
    expect(
      isUniqueViolationOn(composite, 'ProposalVersion', ['proposalId', 'versionNumber', 'x']),
    ).toBe(false);
  });

  it('never matches when the columns are unknown (index-only report or legacy target without a model)', () => {
    const indexOnly = knownError('P2002', {
      modelName: 'Booking',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'booking_x_key' } },
      },
    });
    expect(isUniqueViolationOn(indexOnly, 'Booking', ['bookingReference'])).toBe(false);
    expect(
      isUniqueViolationOn(knownError('P2002', { target: ['bookingReference'] }), 'Booking', [
        'bookingReference',
      ]),
    ).toBe(false);
  });
});

describe('isResidualDatabaseConflict', () => {
  it.each([
    ['exhausted retries', new SerializableRetriesExhaustedError(3, knownError('P2034'))],
    ['a P2034', knownError('P2034')],
    ['a raw adapter write conflict', rawAdapterWriteConflict()],
    ['a P2002', adapterUniqueViolation('Booking', ['"bookingReference"'])],
    ['a P2004', knownError('P2004')],
  ])('treats %s as a residual conflict', (_label, error) => {
    expect(isResidualDatabaseConflict(error)).toBe(true);
  });

  it.each([
    ['a P2025 (record not found)', knownError('P2025')],
    ['a plain Error', new Error('boom')],
  ])('does not treat %s as a conflict', (_label, error) => {
    expect(isResidualDatabaseConflict(error)).toBe(false);
  });
});
