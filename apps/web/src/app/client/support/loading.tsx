// D-051 Stage 4 loading state for `/client/support`. A <div>, never a
// nested <main> — the one <main> landmark is owned by client/layout.tsx.
// Mirrors client/my-journey/loading.tsx and client/bookings/loading.tsx
// exactly.
export default function ClientSupportLoading() {
  return (
    <div>
      <h1>Support & Messages</h1>
      <p role="status">Loading</p>
    </div>
  );
}
