# Frontend Rules

Applies to the public site, admin dashboard, and client portal UI work.

## Mobile-First and Responsive

- Design and implement for small screens first, then progressively enhance for tablet/desktop.
- Every dashboard and portal screen must be usable on a phone, not just "not broken."

## Accessibility

- Use semantic HTML elements (headings, lists, `button`, `nav`, `table`, form labels) instead of generic `div`/`span` where a semantic element fits.
- All interactive elements must be reachable and operable via keyboard alone, with visible focus states.
- Provide accessible names/labels for icon-only controls and form fields.

## Component Design

- Build small, composable components scoped to one responsibility.
- Do not create oversized "universal" components that branch heavily on props to cover unrelated use cases (e.g., one `<DataTable>` trying to serve leads, bookings, and payments with dozens of conditional props) — split by actual need instead.

## Required UI States

Every data-driven view must explicitly handle:

- Loading
- Empty (no data yet, distinct from an error)
- Error (with a retry path where applicable)
- Success
- Permission-denied (distinct from a generic error — the user is authenticated but not authorized)

## Forms

- Validate on the client for immediate feedback, but never trust client validation alone — the server is authoritative.
- Surface server-side validation errors clearly, field-by-field where the API provides field-level errors.
- Preserve user input on validation failure; never clear a form because of a rejected submission.

## Performance

- Avoid unnecessary re-renders and unbounded client-side data fetching (e.g., loading an entire client list to filter it in the browser) once real data volumes exist.
- Paginate or virtualize long lists (leads, clients, bookings, payments) rather than rendering everything at once.

## State Separation

Keep these categories distinct and don't blur them into one global store:

- **Server state** — data fetched from the backend (bookings, payments, documents); treat as cached and revalidated, not owned by the client.
- **Form state** — in-progress input, local to the form until submitted.
- **Local UI state** — things like open/closed modals, active tab, hover state.
- **Persistent client state** — genuine user preferences that belong on the client (e.g., a collapsed sidebar), kept separate from server data.

## Visual Identity

- Preserve the existing Heritage Philippines visual identity (branding, tone, imagery style) from V2; the admin dashboard and client portal should feel related to the public site, not like a disconnected generic admin template.

## Content Integrity

- Never fabricate tour details, prices, availability, or client-facing copy. Use only real, approved content or clearly marked placeholder text that cannot be mistaken for production data (e.g., visible "Sample" labeling in non-production contexts only).
