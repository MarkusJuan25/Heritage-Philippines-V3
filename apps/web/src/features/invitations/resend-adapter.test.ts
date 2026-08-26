import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock, verifyMock, ResendMock } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const verifyMock = vi.fn();
  // A real function expression, not an arrow function — vi.fn()'s `new`
  // support delegates to its implementation via `new`, and an arrow
  // function can never be used as a constructor.
  const ResendMock = vi.fn(function (this: unknown) {
    return { emails: { send: sendMock }, webhooks: { verify: verifyMock } };
  });
  return { sendMock, verifyMock, ResendMock };
});
vi.mock('resend', () => ({ Resend: ResendMock }));

const { getServerEnvMock } = vi.hoisted(() => ({ getServerEnvMock: vi.fn() }));
vi.mock('@/lib/env', () => ({ getServerEnv: getServerEnvMock }));

import {
  buildActivationUrl,
  isAutomatedDeliveryEnabled,
  sendInvitationEmail,
  verifyResendWebhook,
} from './resend-adapter';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://localhost:5432/x',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: undefined as string | undefined,
  RESEND_WEBHOOK_SECRET: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
  EMAIL_REPLY_TO: undefined as string | undefined,
  EMAIL_DELIVERY_ENABLED: 'false' as 'true' | 'false',
};

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnvMock.mockReturnValue({ ...BASE_ENV });
});

describe('isAutomatedDeliveryEnabled', () => {
  it('is false by default (no configuration)', () => {
    expect(isAutomatedDeliveryEnabled()).toBe(false);
  });

  it('is false when the flag is on but the API key or sender is missing', () => {
    getServerEnvMock.mockReturnValue({
      ...BASE_ENV,
      EMAIL_DELIVERY_ENABLED: 'true',
      EMAIL_FROM: 'noreply@x.test',
    });
    expect(isAutomatedDeliveryEnabled()).toBe(false);

    getServerEnvMock.mockReturnValue({
      ...BASE_ENV,
      EMAIL_DELIVERY_ENABLED: 'true',
      RESEND_API_KEY: 're_x',
    });
    expect(isAutomatedDeliveryEnabled()).toBe(false);
  });

  it('is false when every value is configured but the explicit flag is still false — never inferred from key presence alone', () => {
    getServerEnvMock.mockReturnValue({
      ...BASE_ENV,
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'noreply@x.test',
      EMAIL_DELIVERY_ENABLED: 'false',
    });
    expect(isAutomatedDeliveryEnabled()).toBe(false);
  });

  it('is true only when the flag, API key, and sender are all present', () => {
    getServerEnvMock.mockReturnValue({
      ...BASE_ENV,
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'noreply@x.test',
      EMAIL_DELIVERY_ENABLED: 'true',
    });
    expect(isAutomatedDeliveryEnabled()).toBe(true);
  });
});

describe('buildActivationUrl', () => {
  it('builds an activation link from BETTER_AUTH_URL with the raw token URL-encoded', () => {
    getServerEnvMock.mockReturnValue({ ...BASE_ENV, BETTER_AUTH_URL: 'http://localhost:3000/' });
    expect(buildActivationUrl('abc-123')).toBe('http://localhost:3000/activate/abc-123');
  });
});

describe('sendInvitationEmail', () => {
  const params = {
    to: 'client@example.test',
    rawToken: 'raw-token-value',
    sendOperationId: 'op-1',
  };

  beforeEach(() => {
    getServerEnvMock.mockReturnValue({
      ...BASE_ENV,
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'noreply@x.test',
    });
  });

  it('throws when Resend is not configured', async () => {
    getServerEnvMock.mockReturnValue({ ...BASE_ENV });
    await expect(sendInvitationEmail(params, { idempotencyKey: 'k' })).rejects.toThrow(
      /not configured/i,
    );
  });

  it('passes the idempotency key via the SDK second argument, never inside payload headers', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_1' }, error: null });

    await sendInvitationEmail(params, { idempotencyKey: 'portal-invitation/op-1' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [payload, options] = sendMock.mock.calls[0]!;
    expect(options).toEqual({ idempotencyKey: 'portal-invitation/op-1' });
    expect(payload.headers).toBeUndefined();
    expect(payload.tags).toEqual([{ name: 'sendOperationId', value: 'op-1' }]);
  });

  it('classifies a positive response as accepted', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await expect(sendInvitationEmail(params, { idempotencyKey: 'k' })).resolves.toEqual({
      outcome: 'accepted',
      messageId: 'msg_1',
    });
  });

  it('classifies an explicit provider error as a definite failure', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { message: 'invalid_from_address', statusCode: 422, name: 'invalid_from_address' },
    });
    await expect(sendInvitationEmail(params, { idempotencyKey: 'k' })).resolves.toEqual({
      outcome: 'definite-failure',
      message: 'invalid_from_address',
    });
  });

  it('classifies a thrown transport error as ambiguous, never as a definite failure', async () => {
    sendMock.mockRejectedValue(new Error('socket hang up'));
    await expect(sendInvitationEmail(params, { idempotencyKey: 'k' })).resolves.toEqual({
      outcome: 'ambiguous',
      message: 'socket hang up',
    });
  });

  it('classifies a response with neither an error nor a message id as ambiguous', async () => {
    sendMock.mockResolvedValue({ data: {}, error: null });
    await expect(sendInvitationEmail(params, { idempotencyKey: 'k' })).resolves.toMatchObject({
      outcome: 'ambiguous',
    });
  });
});

describe('verifyResendWebhook', () => {
  const headers = { id: 'msg-id', timestamp: '123', signature: 'v1,sig' };

  it('throws when RESEND_WEBHOOK_SECRET is not configured', () => {
    expect(() => verifyResendWebhook('{}', headers)).toThrow(/not configured/i);
  });

  it('returns the verified event on a valid signature', () => {
    getServerEnvMock.mockReturnValue({ ...BASE_ENV, RESEND_WEBHOOK_SECRET: 'whsec_x' });
    verifyMock.mockReturnValue({ type: 'email.sent', data: { email_id: 'msg_1' } });

    const event = verifyResendWebhook('{"a":1}', headers);

    expect(verifyMock).toHaveBeenCalledWith({
      payload: '{"a":1}',
      headers,
      webhookSecret: 'whsec_x',
    });
    expect(event).toEqual({ type: 'email.sent', data: { email_id: 'msg_1' } });
  });

  it('propagates a signature-verification failure to the caller', () => {
    getServerEnvMock.mockReturnValue({ ...BASE_ENV, RESEND_WEBHOOK_SECRET: 'whsec_x' });
    verifyMock.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    expect(() => verifyResendWebhook('{}', headers)).toThrow(/invalid signature/i);
  });
});
