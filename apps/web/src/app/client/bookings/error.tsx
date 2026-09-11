'use client';

// D-049 §7/§11 — the shared segment error boundary for /client/bookings
// (the list route and, cascading, the detail route). A <div role="alert">,
// never a nested <main>. The known layout-owned states (no session,
// non-CLIENT role, no ClientProfile) are handled by the layout and each
// page's own catch and never reach this boundary — this is the generic
// "something unexpected failed" surface only. `error` is deliberately
// never rendered, logged, or otherwise surfaced: it must never expose an
// internal identifier or any other detail.
export default function ClientBookingsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong while loading your bookings.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
