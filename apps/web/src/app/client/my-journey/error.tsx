'use client';

// D-047 §2/§12/§17.5 — the segment-scoped error boundary for the
// proposal-review route only. A <div role="alert">, never a nested <main>
// (the one <main> landmark is client/layout.tsx's). The parent
// apps/web/src/app/client/error.tsx is unchanged. The known layout-owned
// states (no session, non-CLIENT role, no ClientProfile) are handled by the
// layout and the page's D-045 catch and never reach this boundary — this is
// the generic "something unexpected failed" surface. `error` is deliberately
// never rendered, logged, or otherwise surfaced: it must never expose an
// internal identifier, proposal content, session value, or any other detail
// (§11).
export default function ClientMyJourneyError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong while loading your proposals to review.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
