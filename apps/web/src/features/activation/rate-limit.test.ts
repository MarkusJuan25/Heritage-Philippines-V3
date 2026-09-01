import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertMock, deleteManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: { rateLimitBucket: { upsert: upsertMock, deleteMany: deleteManyMock } },
}));

const { getServerEnvMock } = vi.hoisted(() => ({ getServerEnvMock: vi.fn() }));
vi.mock('@/lib/env', () => ({ getServerEnv: getServerEnvMock }));

import {
  SOURCE_LIMIT,
  TOKEN_LIMIT,
  UNKNOWN_SOURCE_BUCKET_KEY,
  checkSourceRateLimit,
  checkTokenRateLimit,
  shouldRunCleanup,
} from './rate-limit';

const NOW = new Date('2026-08-28T10:07:33.123Z');

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnvMock.mockReturnValue({ ACTIVATION_RATE_LIMIT_HMAC_SECRET: 'a'.repeat(32) });
  deleteManyMock.mockResolvedValue({ count: 0 });
});

describe('checkSourceRateLimit', () => {
  it('is not limited when the post-increment count is at or below the limit', async () => {
    upsertMock.mockResolvedValue({ count: SOURCE_LIMIT });
    expect(await checkSourceRateLimit({ trusted: false }, NOW)).toBe(false);
  });

  it('is limited once the post-increment count exceeds the limit', async () => {
    upsertMock.mockResolvedValue({ count: SOURCE_LIMIT + 1 });
    expect(await checkSourceRateLimit({ trusted: false }, NOW)).toBe(true);
  });

  it('uses the shared "unknown-source" bucket key for an untrusted source, without reading the HMAC secret', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkSourceRateLimit({ trusted: false }, NOW);

    const call = upsertMock.mock.calls[0]![0];
    expect(call.where.dimension_bucketKey_windowStart.dimension).toBe('SOURCE');
    expect(call.where.dimension_bucketKey_windowStart.bucketKey).toBe(UNKNOWN_SOURCE_BUCKET_KEY);
    expect(getServerEnvMock).not.toHaveBeenCalled();
  });

  it('derives a 64-hex-character HMAC-SHA256 bucket key (never the raw identifier) for a trusted source', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkSourceRateLimit({ trusted: true, identifier: '203.0.113.7' }, NOW);

    const call = upsertMock.mock.calls[0]![0];
    const bucketKey = call.where.dimension_bucketKey_windowStart.bucketKey as string;
    expect(bucketKey).not.toBe('203.0.113.7');
    expect(bucketKey).toMatch(/^[0-9a-f]{64}$/);
    expect(getServerEnvMock).toHaveBeenCalled();
  });

  it('derives the same bucket key for the same identifier and secret (deterministic)', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkSourceRateLimit({ trusted: true, identifier: '203.0.113.7' }, NOW);
    const first = upsertMock.mock.calls[0]![0].where.dimension_bucketKey_windowStart.bucketKey;

    await checkSourceRateLimit({ trusted: true, identifier: '203.0.113.7' }, NOW);
    const second = upsertMock.mock.calls[1]![0].where.dimension_bucketKey_windowStart.bucketKey;

    expect(first).toBe(second);
  });

  it('floors windowStart to the 15-minute SOURCE fixed window', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkSourceRateLimit({ trusted: false }, NOW);

    const call = upsertMock.mock.calls[0]![0];
    const windowStart = call.where.dimension_bucketKey_windowStart.windowStart as Date;
    expect(windowStart.toISOString()).toBe('2026-08-28T10:00:00.000Z');
  });

  it('creates with count 1 and increments count on conflict', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkSourceRateLimit({ trusted: false }, NOW);

    const call = upsertMock.mock.calls[0]![0];
    expect(call.create.count).toBe(1);
    expect(call.update.count).toEqual({ increment: 1 });
  });
});

describe('checkTokenRateLimit', () => {
  it('is not limited at or below the limit, limited once exceeded', async () => {
    upsertMock.mockResolvedValue({ count: TOKEN_LIMIT });
    expect(await checkTokenRateLimit('digest-abc', NOW)).toBe(false);

    upsertMock.mockResolvedValue({ count: TOKEN_LIMIT + 1 });
    expect(await checkTokenRateLimit('digest-abc', NOW)).toBe(true);
  });

  it('uses the token digest directly as the bucket key, dimension TOKEN — no separate hash', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkTokenRateLimit('digest-abc', NOW);

    const call = upsertMock.mock.calls[0]![0];
    expect(call.where.dimension_bucketKey_windowStart.dimension).toBe('TOKEN');
    expect(call.where.dimension_bucketKey_windowStart.bucketKey).toBe('digest-abc');
  });

  it('floors windowStart to the 60-minute TOKEN fixed window', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await checkTokenRateLimit('digest-abc', NOW);

    const call = upsertMock.mock.calls[0]![0];
    const windowStart = call.where.dimension_bucketKey_windowStart.windowStart as Date;
    expect(windowStart.toISOString()).toBe('2026-08-28T10:00:00.000Z');
  });
});

describe('shouldRunCleanup', () => {
  it('returns true when random() is below the configured probability', () => {
    expect(shouldRunCleanup(() => 0)).toBe(true);
  });

  it('returns false when random() is at or above the configured probability', () => {
    expect(shouldRunCleanup(() => 0.5)).toBe(false);
    expect(shouldRunCleanup(() => 0.999999)).toBe(false);
  });
});

describe('cleanup behavior', () => {
  it('runs cleanup after the rate-limit decision when the probability gate fires, without affecting the outcome', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    deleteManyMock.mockResolvedValue({ count: 3 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    const limited = await checkSourceRateLimit({ trusted: false }, NOW);

    expect(limited).toBe(false);
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });

  it('never runs cleanup when the probability gate does not fire', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);

    await checkSourceRateLimit({ trusted: false }, NOW);

    expect(deleteManyMock).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it('a cleanup failure leaves the already-computed rate-limit outcome unchanged, and logs one fixed sanitized line', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    deleteManyMock.mockRejectedValue(new Error('db unavailable: bucketKey=super-secret-value'));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const limited = await checkSourceRateLimit({ trusted: false }, NOW);

    expect(limited).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[rate-limit] cleanup failed');
    randomSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('deletes only rows strictly older than the 24-hour retention window', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    deleteManyMock.mockResolvedValue({ count: 0 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    await checkSourceRateLimit({ trusted: false }, NOW);

    const call = deleteManyMock.mock.calls[0]![0];
    const cutoff = call.where.windowStart.lt as Date;
    expect(cutoff.toISOString()).toBe(new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString());
    randomSpy.mockRestore();
  });

  it('checkTokenRateLimit also runs the same cleanup gate independently', async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    deleteManyMock.mockResolvedValue({ count: 0 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    await checkTokenRateLimit('digest-abc', NOW);

    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });
});
