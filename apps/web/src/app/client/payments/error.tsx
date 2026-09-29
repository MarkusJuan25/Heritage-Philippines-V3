'use client';

import Link from 'next/link';

// Never renders the caught error's message or details (D-054 §9).
export default function ClientPaymentsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong while loading your payments.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
      <p>
        If this keeps happening, message us in{' '}
        <Link href="/client/support">Support &amp; Messages</Link>.
      </p>
    </div>
  );
}
