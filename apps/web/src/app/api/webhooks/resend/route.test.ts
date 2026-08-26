import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({ handleResendWebhookEvent: vi.fn() }));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { POST } from './route';

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhooks/resend', { method: 'POST', headers, body });
}

const VALID_HEADERS = {
  'svix-id': 'msg-1',
  'svix-timestamp': '1700000000',
  'svix-signature': 'v1,abc',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/resend', () => {
  it('returns 401 without calling the service when Svix headers are missing', async () => {
    const response = await POST(request('{}', {}));
    expect(response.status).toBe(401);
    expect(serviceMocks.handleResendWebhookEvent).not.toHaveBeenCalled();
  });

  it('passes the raw body and Svix headers through unmodified', async () => {
    serviceMocks.handleResendWebhookEvent.mockResolvedValue({ status: 200 });
    const rawBody = '{"type":"email.sent","data":{"email_id":"msg_1"}}';

    const response = await POST(request(rawBody, VALID_HEADERS));

    expect(response.status).toBe(200);
    expect(serviceMocks.handleResendWebhookEvent).toHaveBeenCalledWith(rawBody, {
      id: 'msg-1',
      timestamp: '1700000000',
      signature: 'v1,abc',
    });
  });

  it('returns 401 when the service reports an invalid signature', async () => {
    serviceMocks.handleResendWebhookEvent.mockResolvedValue({ status: 401 });

    const response = await POST(request('{}', VALID_HEADERS));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: expect.any(String) },
    });
  });
});
