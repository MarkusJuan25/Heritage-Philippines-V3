import { beforeEach, describe, expect, it, vi } from 'vitest';

// serializable-transaction.ts imports `prisma` from `@/lib/db`, which eagerly
// validates env vars and opens a real database adapter at import time (see
// db.ts). Mock it before `./serializable-transaction` is imported — the
// same reason features/staff/service.test.ts mocks it.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

import { Prisma } from '@/generated/prisma/client';

import { runSerializableWithRetry } from './serializable-transaction';

const TX_CLIENT = { marker: 'tx-client' };

function serializationConflictError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction.',
    { code: 'P2034', clientVersion: '7.8.0' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
});

describe('runSerializableWithRetry', () => {
  it('runs fn once against the transaction client and returns its result when there is no conflict', async () => {
    const result = await runSerializableWithRetry(async (tx) => {
      expect(tx).toBe(TX_CLIENT);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('retries on a P2034 serialization conflict and succeeds on a later attempt', async () => {
    let attempt = 0;
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      attempt += 1;
      if (attempt < 3) {
        throw serializationConflictError();
      }
      return fn(TX_CLIENT);
    });

    const result = await runSerializableWithRetry(async () => 'succeeded');

    expect(result).toBe('succeeded');
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('gives up and rethrows the raw error after exhausting retries on repeated conflicts', async () => {
    transactionMock.mockImplementation(async () => {
      throw serializationConflictError();
    });

    await expect(runSerializableWithRetry(async () => 'unreachable')).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-conflict error (e.g. a business-rule rejection thrown by fn)', async () => {
    const businessError = new Error('business rule violation');
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));

    await expect(
      runSerializableWithRetry(async () => {
        throw businessError;
      }),
    ).rejects.toBe(businessError);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unrelated PrismaClientKnownRequestError (different code)', async () => {
    const otherError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.8.0',
    });
    transactionMock.mockImplementation(async () => {
      throw otherError;
    });

    await expect(runSerializableWithRetry(async () => 'unreachable')).rejects.toBe(otherError);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
