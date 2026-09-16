'use client';

// D-051 Stage 4 — the segment-scoped error boundary for `/client/support`
// only. A <div role="alert">, never a nested <main> (the one <main>
// landmark is client/layout.tsx's). The parent apps/web/src/app/client/error.tsx
// is unchanged. The known layout-owned states (no session, non-CLIENT
// role, no ClientProfile) are handled by the layout and this page's own
// D-045-style catch, and never reach this boundary — this is the generic
// "something unexpected failed" surface. `error` is deliberately never
// rendered, logged, or otherwise surfaced: it must never expose an
// internal identifier, conversation content, session value, or any other
// detail. Mirrors client/my-journey/error.tsx exactly.
export default function ClientSupportError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong while loading your conversations.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
