import { describe, expect, it } from 'vitest';

import {
  MESSAGE_BODY_MAX_LENGTH,
  conversationCategorySchema,
  messageBodySchema,
  messageVisibilitySchema,
} from './schemas';

describe('messageBodySchema', () => {
  it('rejects an empty string', () => {
    expect(messageBodySchema.safeParse('').success).toBe(false);
  });

  it('rejects a whitespace-only string (D-051 §16)', () => {
    expect(messageBodySchema.safeParse('   \n\t  ').success).toBe(false);
  });

  it('trims surrounding whitespace on an otherwise valid body', () => {
    const result = messageBodySchema.safeParse('  Hello there  ');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('Hello there');
    }
  });

  it('accepts a body at exactly the maximum length', () => {
    const body = 'a'.repeat(MESSAGE_BODY_MAX_LENGTH);
    expect(messageBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a body one character beyond the maximum length', () => {
    const body = 'a'.repeat(MESSAGE_BODY_MAX_LENGTH + 1);
    expect(messageBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('conversationCategorySchema', () => {
  it('accepts every one of the eight existing category values', () => {
    const categories = [
      'GENERAL_INQUIRY',
      'PROPOSAL_ROS',
      'BOOKING',
      'PAYMENT',
      'DOCUMENTS',
      'VISA',
      'TRAVEL_PREPARATION',
      'TECHNICAL_SUPPORT',
    ];
    for (const category of categories) {
      expect(conversationCategorySchema.safeParse(category).success).toBe(true);
    }
  });

  it('rejects a value outside the closed enum (D-051 §4 — no invented category)', () => {
    expect(conversationCategorySchema.safeParse('NOT_A_REAL_CATEGORY').success).toBe(false);
  });
});

describe('messageVisibilitySchema', () => {
  it('accepts CLIENT_VISIBLE and INTERNAL_NOTE only', () => {
    expect(messageVisibilitySchema.safeParse('CLIENT_VISIBLE').success).toBe(true);
    expect(messageVisibilitySchema.safeParse('INTERNAL_NOTE').success).toBe(true);
  });

  it('rejects any other value', () => {
    expect(messageVisibilitySchema.safeParse('SOMETHING_ELSE').success).toBe(false);
  });
});
