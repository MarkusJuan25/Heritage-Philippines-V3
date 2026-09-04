'use client';

// D-040 §7 Error / retry state — verbatim. A <div role="alert">, never a
// nested <main>. D-040 §7: the layout (Layer 2) handles the known
// `FORBIDDEN` / `PROFILE_NOT_SET_UP` outcomes, so those never reach this
// boundary — this is the generic "something unexpected failed" surface
// only. `error` is intentionally not rendered, logged, or otherwise
// surfaced: it must never expose an internal identifier or detail
// (D-040 §8).
export default function ClientOverviewError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong while loading your overview.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
