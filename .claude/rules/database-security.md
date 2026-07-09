# Database and Security Rules

## Identifiers and Timestamps

- Every entity has a stable, immutable identifier that is never reused after deletion.
- Every entity records creation and last-update timestamps; entities with a lifecycle (lead, proposal, booking, payment, visa case) also record status-change timestamps (e.g., `LeadStatusHistory`, `VisaStatusHistory` per blueprint Section 14).

## Relationships and Referential Integrity

- Model the relationships implied by blueprint Section 14 explicitly (foreign keys), rather than relying on loosely-typed reference fields.
- Enforce referential integrity at the database level, not only in application code.

## Constraints and Indexes

- Add unique constraints where the blueprint implies uniqueness (e.g., one active `PortalInvitation` token per invitation, one confirmed `Receipt` per confirmed `Payment`).
- Index fields used for duplicate detection (email, phone), assignment lookups, and status filtering, once real query patterns are known.

## Safe Migrations

- Migrations must be additive and backward-compatible where possible; avoid destructive migrations (dropping columns/tables with live data) without an explicit backup and rollback plan.
- Review every migration against currently-running code paths before applying it to staging or production.

## Soft Deletion

- Use soft deletion only where the blueprint or a business need justifies retaining history (e.g., leads per Section 6.5's archive rule, superseded proposal versions per Section 9). Do not default every entity to soft-delete without a reason — it adds query complexity that should be justified.

## Audit Records

- Sensitive operations (payment confirm/reverse/refund/adjust, role/permission change, document approve/reject, visa status change) write an `AuditLog` entry with actor, timestamp, action, and before/after state, per blueprint Section 14.9.

## Monetary Values

- Store and compute all monetary values using an exact decimal representation (e.g., a fixed-point/decimal database type and matching decimal arithmetic in application code). Never use binary floating-point (e.g., JavaScript `number`/IEEE 754 float) for money.
- Document one single currency strategy (base currency, whether multi-currency is supported, and how conversion — if any — is handled) before payment features are implemented; treat this as an open decision until then.

## Server-Side Computation

- Confirmed amount paid and remaining balance (blueprint Section 11.1) are computed and validated server-side on every read and write; a client never supplies or overrides these values directly.

## Protecting Sensitive Data

- Passwords are hashed with a strong, purpose-built algorithm; never stored or logged in plaintext.
- Session tokens, invitation tokens, and password-reset tokens are single-purpose, time-limited, and stored in a way that a database read alone can't be replayed as a valid token (e.g., hashed at rest where applicable).
- Personal information, payment records, and documents are accessible only per the role/assignment/ownership rules in blueprint Section 4, and `admin-dashboard.md` / `client-portal.md`.
- Administrator actions on sensitive data are always attributable to a specific account (no shared/generic admin logins).

## Secret Management

- Secrets (API keys, database credentials, signing keys) live in environment configuration or a secrets manager — never in source code or committed files.

## Additional Baseline Protections

- Rate limiting on public and authentication endpoints.
- Secure HTTP headers (e.g., HSTS, CSP, X-Content-Type-Options) once a hosting/deployment target is chosen.
- Logging hygiene: never log passwords, tokens, full payment card data, or full document contents.
- Input validation at every external boundary (see `backend.md`).
- Authorization checks on every data access, not just at the UI layer.
- Safe file handling for uploads: validate file type and size, scan for malware, and store outside any web-servable path with access mediated by signed/expiring links (blueprint Section 12.3).

## Data Minimization and Retention

- Collect only the personal fields operationally necessary (blueprint Section 13.3).
- Define retention periods for leads, documents, and logs as part of implementation planning; exact durations are open decisions (blueprint Section 16.2) until confirmed.
