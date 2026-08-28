import { describe, expect, it } from 'vitest';

import { activateSchema, activationTokenSchema, continueSchema } from './schemas';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';

describe('activationTokenSchema', () => {
  it('accepts a valid 24-character token', () => {
    expect(activationTokenSchema.safeParse(VALID_TOKEN).success).toBe(true);
  });

  it.each(['too-short', VALID_TOKEN + 'X', 'has spaces here!!!!!!!!!', ''])(
    'rejects %s',
    (value) => {
      expect(activationTokenSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('continueSchema', () => {
  it('accepts a valid token', () => {
    expect(continueSchema.safeParse({ token: VALID_TOKEN }).success).toBe(true);
  });

  it('rejects a missing token', () => {
    expect(continueSchema.safeParse({}).success).toBe(false);
  });
});

describe('activateSchema', () => {
  const base = {
    token: VALID_TOKEN,
    password: 'correct-horse-battery',
    confirmPassword: 'correct-horse-battery',
  };

  it('accepts matching passwords at least 12 characters', () => {
    expect(activateSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a password shorter than 12 characters', () => {
    const result = activateSchema.safeParse({
      ...base,
      password: 'short1',
      confirmPassword: 'short1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.message === 'Password must be at least 12 characters.',
        ),
      ).toBe(true);
    }
  });

  it('rejects a password longer than 200 characters', () => {
    const tooLong = 'a'.repeat(201);
    const result = activateSchema.safeParse({
      ...base,
      password: tooLong,
      confirmPassword: tooLong,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.message === 'Password must not exceed 200 characters.',
        ),
      ).toBe(true);
    }
  });

  it('rejects mismatched passwords, attributed to confirmPassword', () => {
    const result = activateSchema.safeParse({
      ...base,
      password: 'correct-horse-battery',
      confirmPassword: 'different-password-value',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.message === 'Passwords do not match.');
      expect(issue?.path).toEqual(['confirmPassword']);
    }
  });

  it('rejects a malformed token', () => {
    expect(activateSchema.safeParse({ ...base, token: 'not-a-valid-token' }).success).toBe(false);
  });
});
