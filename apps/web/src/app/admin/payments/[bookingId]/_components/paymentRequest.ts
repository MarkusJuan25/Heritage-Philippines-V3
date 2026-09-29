'use client';

import { useCallback, useState } from 'react';

export const GENERIC_ERROR_MESSAGE =
  'Something went wrong. Please check your connection and try again.';

export type RequestOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: string | null; message: string; fieldErrors: Record<string, string> };

type ApiErrorBody = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error as Record<string, unknown> | undefined;
  return (
    !!error &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    (error.details === undefined || Array.isArray(error.details))
  );
}

/**
 * Sends one JSON request to a payments or assignment route and normalizes
 * the outcome. Every rule is decided server-side: this helper only carries
 * the server's own safe message (and field-level validation details, keyed
 * by field path) back to the form, and never treats a malformed success
 * body or a network failure as success.
 */
export async function sendJson(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
): Promise<RequestOutcome> {
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    json = await response.json();
  } catch {
    return { ok: false, code: null, message: GENERIC_ERROR_MESSAGE, fieldErrors: {} };
  }

  if (response.ok) {
    return json && typeof json === 'object'
      ? { ok: true, body: json as Record<string, unknown> }
      : { ok: false, code: null, message: GENERIC_ERROR_MESSAGE, fieldErrors: {} };
  }

  if (!isApiErrorBody(json)) {
    return { ok: false, code: null, message: GENERIC_ERROR_MESSAGE, fieldErrors: {} };
  }
  const fieldErrors: Record<string, string> = {};
  for (const detail of json.error.details ?? []) {
    if (detail.path && !fieldErrors[detail.path]) fieldErrors[detail.path] = detail.message;
  }
  return { ok: false, code: json.error.code, message: json.error.message, fieldErrors };
}

/**
 * An idempotency key for one intended operation (D-054 §8; §17 Rule 6).
 * The same key is resent when the user retries an unchanged request after a
 * failure — so a request that did reach the server is answered with its
 * original result, never applied twice — and a new key is issued once the
 * operation succeeds or the user edits the form (a changed request under
 * the old key would be an IDEMPOTENCY_KEY_CONFLICT).
 */
export function useIdempotencyKey(): { key: string; renew: () => void } {
  const [key, setKey] = useState(() => crypto.randomUUID());
  const renew = useCallback(() => setKey(crypto.randomUUID()), []);
  return { key, renew };
}
