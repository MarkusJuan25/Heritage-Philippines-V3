# Client Portal Rules

## Navigation Areas

The client portal exposes exactly these areas (blueprint Section 2.3):

- Home / Overview
- My Journey
- Bookings
- Payments & Receipts
- Documents
- Visa Center
- Regional Tours
- Support & Messages
- Profile
- Settings

## Strict Ownership Checks

- Every request for client-facing data (proposals, bookings, payments, receipts, documents, visa case, messages, profile) must verify the authenticated client owns that specific record — on every request, not only at login.
- Never rely on a client-supplied ID alone to select which record to return; always scope the query by the authenticated client's identity first.

## Journey and Booking Timelines

- Present the client journey and booking status clearly and in order (blueprint Section 8), using the platform's actual defined statuses — do not invent intermediate states not defined in the blueprint.

## Installment and Balance Presentation

For every booking with a payment plan, the client view must accurately show, per blueprint Section 11:

- Total booking amount
- Confirmed amount paid (confirmed payments only)
- Remaining balance
- Full payment history (with each payment's status)
- Next payment due and its due date

These values must come from the same server-side calculation used everywhere else in the system — never recomputed independently in the client portal.

## Receipts and Documents

- Clients may only view or download their own receipts and documents.
- Use secure, expiring download links for sensitive files rather than exposing permanent direct URLs (blueprint Section 12.3).

## Empty States and Support Escalation

- Every client area must have a helpful empty state (e.g., "No bookings yet" with guidance) rather than a blank or broken-looking screen.
- Provide a clear path from any client screen to Support & Messages when the client needs help with what they're viewing.

## Mobile-Friendly Account Navigation

- The portal's left-side navigation must collapse into a usable mobile pattern (e.g., bottom nav or drawer) rather than simply shrinking a desktop sidebar.

## Absolute Client Isolation

- Under no condition may one client's data (profile, bookings, payments, documents, visa case, messages) be visible or reachable by another client, regardless of UI state, caching, or error handling. Treat any cross-client data leak as a critical severity issue.
