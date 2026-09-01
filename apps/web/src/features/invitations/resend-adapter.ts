import { Resend } from 'resend';

import { getServerEnv } from '@/lib/env';

// Isolates every direct dependency on the `resend` package behind this
// feature's own boundary (D-034 Section 12; .claude/rules/architecture.md's
// "cross-feature reuse goes through explicit shared contracts") — a future
// provider swap touches only this file.

// Cached only for the send path (keyed implicitly by the fact that
// RESEND_API_KEY is a single, process-lifetime-constant configuration
// value once set). The webhook-verification path deliberately does NOT
// share this cache — see `verifyResendWebhook` below — so a webhook
// request handled before any send never poisons the send client with a
// placeholder key.
let cachedSendClient: Resend | undefined;

function getResendSendClient(apiKey: string): Resend {
  if (!cachedSendClient) {
    cachedSendClient = new Resend(apiKey);
  }
  return cachedSendClient;
}

/**
 * Fail-closed automated-delivery gate (D-034 Section 12): automated
 * sending is never inferred solely from `RESEND_API_KEY`'s presence — the
 * explicit `EMAIL_DELIVERY_ENABLED` switch and a configured `EMAIL_FROM`
 * sender identity must *both* also be true/present. Checked at the point
 * of sending, in the service layer, not only at the route/UI layer
 * (.claude/rules/backend.md).
 */
export function isAutomatedDeliveryEnabled(): boolean {
  const env = getServerEnv();
  return (
    env.EMAIL_DELIVERY_ENABLED === 'true' && Boolean(env.RESEND_API_KEY) && Boolean(env.EMAIL_FROM)
  );
}

/**
 * The activation link embedded in the invitation email. Built from the
 * already-validated `BETTER_AUTH_URL` base (the same origin this
 * application's own auth callbacks already use). D-038 Section 2 is the
 * authoritative route contract: the raw token travels only in a URL
 * fragment (`#token=...`), never in the request path or query string —
 * a fragment is never transmitted to any server (RFC 3986 §3.5), which
 * is what closes the raw-token exposure D-034 Stage 5e's own live-HTTP
 * evidence found in the prior `/activate/<token>` path-based design
 * (Next.js App Router's RSC/Flight hydration payload unconditionally
 * serializes a dynamic path segment's — or a non-empty query string's —
 * actual value; a fragment has no server-visible equivalent for it to
 * serialize). This is the sole authorized shape for this function's
 * output (D-038 Section 2) — kept in this one function so any future
 * adjustment touches nothing else in this feature.
 */
export function buildActivationUrl(rawToken: string): string {
  const base = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, '');
  return `${base}/activate#token=${encodeURIComponent(rawToken)}`;
}

function buildInvitationEmailHtml(activationUrl: string): string {
  return [
    '<p>You have been invited to activate your Heritage Philippines client portal account.</p>',
    `<p><a href="${activationUrl}">Activate your account</a></p>`,
    '<p>This link expires in 7 days. If you did not expect this invitation, you can safely ignore this email.</p>',
  ].join('\n');
}

export type SendInvitationEmailParams = {
  to: string;
  rawToken: string;
  sendOperationId: string;
};

export type SendOutcome =
  | { outcome: 'accepted'; messageId: string }
  | { outcome: 'definite-failure'; message: string }
  | { outcome: 'ambiguous'; message: string };

/**
 * Sends the invitation email through Resend and classifies the outcome
 * (D-034 Stage 3 Section 7 correction — the SDK's `{ data, error }`
 * contract is not "throws on failure"):
 *
 *   - `data` with a message id -> 'accepted' (provider positively
 *     responded; never itself confirmed recipient delivery).
 *   - an explicit `error` in the response -> 'definite-failure' (the
 *     provider affirmatively rejected the request).
 *   - a thrown exception (network/transport interruption, timeout) ->
 *     'ambiguous' — the provider's actual outcome is genuinely unknown and
 *     must never be classified as a definite failure.
 *
 * `options.idempotencyKey` is passed via the SDK's second argument
 * (`resend.emails.send(payload, { idempotencyKey })`), never inside the
 * payload's own `headers` — confirmed against the installed `resend`
 * package's own type declarations
 * (node_modules/resend/dist/index.d.mts: `CreateEmailRequestOptions
 * extends PostOptions, IdempotentRequest` where `IdempotentRequest.
 * idempotencyKey?: string`).
 */
export async function sendInvitationEmail(
  params: SendInvitationEmailParams,
  options: { idempotencyKey: string },
): Promise<SendOutcome> {
  const env = getServerEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error('Resend is not configured (RESEND_API_KEY/EMAIL_FROM missing).');
  }

  const resend = getResendSendClient(env.RESEND_API_KEY);
  const activationUrl = buildActivationUrl(params.rawToken);

  try {
    const { data, error } = await resend.emails.send(
      {
        from: env.EMAIL_FROM,
        to: params.to,
        replyTo: env.EMAIL_REPLY_TO,
        subject: 'Activate your Heritage Philippines client portal account',
        html: buildInvitationEmailHtml(activationUrl),
        // Non-sensitive correlation tag (D-034 Stage 3 Section 6
        // correction) — lets the webhook handler fall back to
        // sendOperationId-based correlation when a provider timeout meant
        // providerMessageId was never captured from the synchronous
        // response.
        tags: [{ name: 'sendOperationId', value: params.sendOperationId }],
      },
      { idempotencyKey: options.idempotencyKey },
    );

    if (error) {
      return { outcome: 'definite-failure', message: error.message };
    }
    if (!data?.id) {
      return { outcome: 'ambiguous', message: 'Provider returned no error but no message id.' };
    }
    return { outcome: 'accepted', messageId: data.id };
  } catch (err) {
    return {
      outcome: 'ambiguous',
      message: err instanceof Error ? err.message : 'Unknown transport error.',
    };
  }
}

// Mirrors the installed SDK's own BaseEmailEventData shape
// (node_modules/resend/dist/index.d.mts): `tags` on a webhook *event*
// payload is a flat `Record<string,string>` map — a different shape than
// the `{name,value}[]` array `emails.send`'s own request payload takes.
export type VerifiedWebhookEvent = {
  type: string;
  data: { email_id?: string; tags?: Record<string, string> } & Record<string, unknown>;
};

/**
 * Verifies a Resend webhook request's Svix signature against the raw
 * request body and returns the parsed event on success (D-034 Section 2(b)
 * as corrected by Stage 3 Section 8: verified via the `resend` SDK's own
 * `resend.webhooks.verify()`, confirmed present in the installed
 * resend@6.22.1 — no separate `svix` dependency needed). Throws on an
 * invalid/missing signature; the caller (the webhook route) must reject
 * the request without processing it, never fall back to trusting an
 * unverified payload.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: { id: string; timestamp: string; signature: string },
): VerifiedWebhookEvent {
  const env = getServerEnv();
  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new Error('RESEND_WEBHOOK_SECRET is not configured.');
  }
  // A fresh, uncached client — verification is a pure local signature
  // check (no Resend API call), and this must never share
  // `getResendSendClient`'s cache (a webhook request handled before any
  // send has happened would otherwise poison that cache with a
  // send-unusable placeholder key).
  const resend = new Resend(env.RESEND_API_KEY);
  // The SDK's real return type is a large discriminated union covering
  // every Resend webhook event (email/contact/domain/suppression) with
  // per-variant `data` shapes, several of which don't structurally
  // overlap with this feature's own narrowed `VerifiedWebhookEvent` (this
  // feature only ever reads `type` and `data.email_id`/`data.tags`, both
  // present on every email.* variant). `unknown` is the correct,
  // type-safe bridge for a deliberately-narrowed view of a wider union —
  // not a loophole, since every field this feature actually reads is
  // still checked against `VerifiedWebhookEvent`'s own declared shape.
  return resend.webhooks.verify({
    payload: rawBody,
    headers,
    webhookSecret: env.RESEND_WEBHOOK_SECRET,
  }) as unknown as VerifiedWebhookEvent;
}
