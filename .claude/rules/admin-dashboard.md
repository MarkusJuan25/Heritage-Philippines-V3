# Admin Dashboard Rules

## Role-Based, Least-Privilege Access

- Enforce the six roles and their boundaries exactly as defined in blueprint Section 4 (System Administrator, Admin / Manager, Travel Consultant, Finance / Accounting, Visa Documentation Staff, Client — Client does not use the admin dashboard).
- Access is assignment-based where the blueprint specifies it (e.g., a Travel Consultant sees only their assigned leads/clients/bookings).
- Never grant a broader permission "for convenience"; if a screen needs a capability no role has, flag it as a scope question rather than expanding a role silently.

## Visibility Scoping

- Admin dashboard views into users, leads, clients, proposals, bookings, payments, documents, content, and support must be filtered by the viewing staff member's role and assignments before rendering — never filtered only in the UI after fetching everything.

## Search, Filtering, Pagination, and Status

- List views (leads, clients, bookings, payments, documents, visa cases) must support search, filtering, and pagination once real data volumes exist.
- Status indicators must reflect the actual lifecycle statuses defined in the blueprint (Sections 6, 9, 11, 13.4, 13.8), not ad hoc labels invented in the UI layer.

## Destructive and Irreversible Actions

- Actions such as revoking access, reversing a payment, rejecting a document, or archiving a lead require an explicit confirmation step.
- Irreversible actions must be logged with actor, timestamp, and reason.

## Audit Trails

- Sensitive changes (role/permission changes, payment confirmation/reversal/adjustment, document approval/rejection, visa status changes, booking status changes) are recorded per `backend.md`'s auditability rule and are visible to System Administrator and Admin / Manager.

## Permission Granularity

Distinguish, per role, between:

- Viewing
- Creating
- Editing
- Approving
- Exporting
- Deleting

A role having one of these on a resource does not imply it has the others.

## Mass Assignment and Unauthorized Access Protection

- Never bind a raw request body directly onto a database model; only accept and apply the specific fields a given role is allowed to set for that action.
- Every fetch of a specific record (a client, booking, payment, document) must re-check that the requesting staff member is authorized for that specific record, not just for the resource type in general.

## Verified Dashboard Metrics

- Dashboard overview metrics (new inquiries, payments due, overdue payments, pending reviews, etc. — blueprint Section 13.1) must be computed from verified backend queries, not estimated or computed client-side from partial data.
