'use client';

import { useId, useRef, useState, type FormEvent } from 'react';

// D-038 Section 4 (superseding D-037 Section 4's `window.location.pathname`
// design): the raw token is never passed to this component as a prop, a
// hidden form input, a `data-*` attribute, rendered visible text, a
// cookie, or any persistent browser-storage value — it is derived
// transiently, at the moment of each Continue/Activate action, from
// `window.location.hash`, held only in a function-local variable inside
// the handler that needs it, never assigned to component state or a ref,
// never logged, never included in any request other than the one
// same-origin JSON POST body it belongs to. A URL fragment is never part
// of any HTTP request a browser sends (RFC 3986 §3.5) — this component is
// the only place in the entire application that ever reads it.
const TOKEN_HASH_PATTERN = /^#token=([A-Za-z0-9_-]{24})$/;

function readTokenFromLocation(): string | null {
  const match = TOKEN_HASH_PATTERN.exec(window.location.hash);
  return match?.[1] ?? null;
}

const GENERIC_INVALID_MESSAGE = 'This invitation link is no longer valid.';

type UiState =
  | { kind: 'not-opened' }
  | { kind: 'opened' }
  | { kind: 'submitting' }
  | { kind: 'invalid' }
  | { kind: 'success' };

type FieldErrors = Record<string, string>;

// D-038 Section 3: GET /activate always renders the identical, fixed,
// non-enumerating Continue state — there is no longer a server-determined
// initial state to accept as a prop, since the server performs no lookup
// of any kind.
export function ActivationForm() {
  const [ui, setUi] = useState<UiState>({ kind: 'not-opened' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // Synchronous guard, checked/set before any `await`, cleared in
  // `finally` — mirrors PortalInvitationPanel's established
  // `pendingActionRef` pattern, blocking a second submission before React
  // commits the corresponding `useState` update.
  const pendingActionRef = useRef(false);

  const passwordId = useId();
  const confirmPasswordId = useId();

  async function handleContinue() {
    if (pendingActionRef.current) return;
    const token = readTokenFromLocation();
    if (!token) {
      setUi({ kind: 'invalid' });
      return;
    }

    pendingActionRef.current = true;
    setUi({ kind: 'submitting' });
    try {
      const response = await fetch('/api/activation/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        setUi({ kind: 'opened' });
        return;
      }
      // D-038 Section 4: a rate-limit rejection is recoverable — the
      // token itself remains valid, so the user can simply retry Continue
      // once the limit clears, without needing to re-open the original
      // link. Staying in 'not-opened' (never cleared from the URL)
      // preserves that ability; the token is re-read fresh on the retry.
      if (response.status === 429) {
        setUi({ kind: 'not-opened' });
        return;
      }
      setUi({ kind: 'invalid' });
    } catch {
      setUi({ kind: 'invalid' });
    } finally {
      pendingActionRef.current = false;
    }
  }

  async function handleActivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingActionRef.current) return;
    const token = readTokenFromLocation();
    if (!token) {
      setUi({ kind: 'invalid' });
      return;
    }

    pendingActionRef.current = true;
    setFieldErrors({});
    setUi({ kind: 'submitting' });
    try {
      const response = await fetch('/api/activation/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });

      if (response.ok) {
        setUi({ kind: 'success' });
        // Replace, not push, so the token-bearing history entry is
        // overwritten wherever the browser's history API honors it
        // (D-038 Section 4). No caller-controlled redirect target is ever
        // read from the response or the request — this destination is a
        // single hard-coded literal.
        window.location.replace('/login?activated=1');
        return;
      }

      if (response.status === 400) {
        const body: unknown = await response.json().catch(() => null);
        const details =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error?: { details?: { path: string; message: string }[] } }).error?.details
            : undefined;
        if (details && details.length > 0) {
          const next: FieldErrors = {};
          for (const issue of details) {
            next[issue.path] = issue.message;
          }
          setFieldErrors(next);
          setUi({ kind: 'opened' });
          return;
        }
      }

      // D-038 Section 4: a SOURCE- or TOKEN-dimension rate-limit rejection
      // (429) is a recoverable condition, not a terminal one — the token
      // itself is still perfectly valid, so the user must be able to
      // retry once the limit clears without needing to re-open the
      // original link. Returning to 'opened' (not 'invalid') preserves
      // the password form and both submitted field values, and — since
      // the fragment is never cleared on this branch — Activate can
      // re-read the token fresh from the URL exactly as before.
      if (response.status === 429) {
        setUi({ kind: 'opened' });
        return;
      }

      setUi({ kind: 'invalid' });
    } catch {
      setUi({ kind: 'invalid' });
    } finally {
      pendingActionRef.current = false;
    }
  }

  if (ui.kind === 'invalid') {
    return (
      <>
        <p role="status">{GENERIC_INVALID_MESSAGE}</p>
        <p>
          <a href="/login">Go to sign in</a>
        </p>
      </>
    );
  }

  if (ui.kind === 'success') {
    return <p role="status">Account activated. Redirecting to sign in…</p>;
  }

  if (ui.kind === 'not-opened') {
    return (
      <button type="button" onClick={handleContinue}>
        Continue
      </button>
    );
  }

  // 'opened' and 'submitting' both render the password form — submitting
  // additionally disables its controls, backstopped (not replaced) by the
  // server-side transactional recheck.
  const submitting = ui.kind === 'submitting';

  return (
    <form onSubmit={handleActivate}>
      <div>
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          disabled={submitting}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {fieldErrors.password ? <p role="alert">{fieldErrors.password}</p> : null}
      </div>
      <div>
        <label htmlFor={confirmPasswordId}>Confirm password</label>
        <input
          id={confirmPasswordId}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={submitting}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        {fieldErrors.confirmPassword ? <p role="alert">{fieldErrors.confirmPassword}</p> : null}
      </div>
      <button type="submit" disabled={submitting}>
        {submitting ? 'Activating…' : 'Activate account'}
      </button>
    </form>
  );
}
