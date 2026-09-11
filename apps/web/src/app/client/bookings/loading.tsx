// D-049 §7 — the shared loading state for the /client/bookings segment (the
// list route and, cascading, the detail route — §11 Stage 3). A <div>,
// never a nested <main> — the one <main> landmark is client/layout.tsx's.
export default function ClientBookingsLoading() {
  return (
    <div>
      <h1>Bookings</h1>
      <p role="status">Loading</p>
    </div>
  );
}
