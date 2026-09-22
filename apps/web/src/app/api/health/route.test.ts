import { describe, expect, it, vi } from 'vitest';

// D-053 Stage 2 (A7): mocks only the external database boundary
// (`@/lib/db`'s exported `prisma` singleton), exactly mirroring the
// established pattern used across this codebase's service-layer tests
// (e.g. `features/bookings/service.test.ts`). This is required, not
// optional — `@/lib/db.ts` calls `getServerEnv()` and constructs a real
// `PrismaPg` adapter at module load, so importing the route under test
// without this mock in place would evaluate the real environment schema
// and attempt a real driver-adapter construction rather than exercising
// this file's own logic.
const dbMocks = vi.hoisted(() => ({ queryRawMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: dbMocks.queryRawMock },
}));

import { GET } from './route';

const SERVICE_NAME = 'heritage-philippines-v3-web';

describe('GET /api/health', () => {
  it('returns the healthy response with HTTP 200 when the database is reachable', async () => {
    dbMocks.queryRawMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: expect.any(String),
    });
    expect(dbMocks.queryRawMock).toHaveBeenCalledTimes(1);
  });

  it('returns a distinct non-"ok" response with HTTP 503 when the database is unreachable, without weakening the healthy-case contract', async () => {
    dbMocks.queryRawMock.mockRejectedValueOnce(new Error('connection refused'));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).not.toBe('ok');
    expect(body).toEqual({
      status: 'error',
      service: SERVICE_NAME,
      timestamp: expect.any(String),
    });
  });

  it('never exposes the underlying database error message, connection details, or stack trace in the unreachable response', async () => {
    const sensitiveError = new Error(
      'connection refused: postgresql://app_user:s3cret-p4ss@db.internal.example:5432/heritage_v3_prod',
    );
    dbMocks.queryRawMock.mockRejectedValueOnce(sensitiveError);

    const response = await GET();
    const rawText = await response.text();

    expect(rawText).not.toContain('s3cret-p4ss');
    expect(rawText).not.toContain('db.internal.example');
    expect(rawText).not.toContain('postgresql://');
    expect(rawText).not.toContain('app_user');
    expect(rawText).not.toContain('connection refused');
    if (sensitiveError.stack) {
      expect(rawText).not.toContain(sensitiveError.stack);
    }
    // The response is still the exact, fixed unreachable shape — the
    // absence check above isn't satisfied merely by an empty/broken body.
    expect(JSON.parse(rawText)).toEqual({
      status: 'error',
      service: SERVICE_NAME,
      timestamp: expect.any(String),
    });
  });

  it('rejects a non-Error thrown value the same way, still leaking nothing', async () => {
    dbMocks.queryRawMock.mockRejectedValueOnce('a raw string rejection, not an Error instance');

    const response = await GET();
    const rawText = await response.text();

    expect(response.status).toBe(503);
    expect(rawText).not.toContain('a raw string rejection');
    expect(JSON.parse(rawText)).toEqual({
      status: 'error',
      service: SERVICE_NAME,
      timestamp: expect.any(String),
    });
  });
});
