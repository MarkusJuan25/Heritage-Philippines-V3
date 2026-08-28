'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { signIn } from '@/lib/auth/auth-client';

// Phase 1 verification surface only: sign-in for accounts created via the
// dev seed script today, and a real staff/portal-invitation flow in a
// later phase (blueprint Section 7). Public self-service sign-up is
// intentionally not offered here — see src/lib/auth/auth.ts.
export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // D-034 Section 14; D-037 Section 4: the fixed, non-sensitive
  // post-activation success indicator — `useSearchParams` reads it
  // correctly on both the server-rendered initial HTML and the client,
  // from the actual request URL, requiring the `Suspense` boundary above
  // per Next.js's own App Router contract for this hook.
  const searchParams = useSearchParams();
  const justActivated = searchParams.get('activated') === '1';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('submitting');
    setErrorMessage(null);

    const { error } = await signIn.email({ email, password });

    if (error) {
      setStatus('error');
      setErrorMessage(error.message ?? 'Could not sign in with those credentials.');
      return;
    }

    router.push('/dashboard');
    router.refresh();
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p>Heritage Philippines V3 staff and client sign-in.</p>
      {justActivated ? (
        <p role="status">Your account has been activated. Sign in to continue.</p>
      ) : null}
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {status === 'error' && errorMessage ? <p role="alert">{errorMessage}</p> : null}
        <button type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
