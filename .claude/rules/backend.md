# Backend Rules

## Layered Request Processing

Each request flows through distinct layers, in order:

1. **Transport/route layer** — receives the request, does nothing else.
2. **Validation layer** — validates and parses input against a schema.
3. **Auth layer** — confirms authentication, then authorization (role + assignment) for the specific resource requested.
4. **Service layer** — executes business rules (status transitions, balance calculations, duplicate checks, etc.).
5. **Repository/data-access layer** — the only layer that talks to the database.

Do not skip layers or let a route handler call the database directly.

## Schema Validation at External Boundaries

- Validate every external input — HTTP body/query/params, uploaded files, webhook payloads — before it reaches business logic.
- Reject invalid input with a clear, consistent error rather than allowing it to propagate and fail deeper in the stack.

## Authentication vs. Authorization

- Authentication confirms *who* is making the request.
- Authorization confirms *what that identity is allowed to do with this specific resource*, per the role boundaries and assignment model in blueprint Section 4.
- These are separate checks; a valid session does not imply access to a given lead, client, booking, payment, or document.

## Service-Level Business Rules

- Status-lifecycle transitions (lead, proposal/ROS, booking, payment, document, visa case) are enforced in the service layer, not left to the client or database constraints alone.
- Role-specific restrictions (e.g., a Travel Consultant cannot confirm a payment) are enforced server-side regardless of what the UI exposes.

## Repository / Data-Access Boundaries

- Data-access code returns domain-shaped data to the service layer; it does not contain business rules.
- Cross-feature data access goes through the owning feature's repository/service, not through ad hoc queries against another feature's tables.

## Consistent Error Responses

- Use a consistent error response shape (code, message, optionally field-level details) across the API.
- Do not leak internal error details, stack traces, or database error text to the client.

## Idempotency for Sensitive Operations

- Payment confirmation, payment reversal, payment adjustment, and document-replacement operations must be safe to retry without double-applying an effect (e.g., a duplicate confirmation request must not double-count a payment).
- Design these endpoints to accept an idempotency key or equivalent safeguard once implementation begins.

## Auditability

- Record who did what and when for: account/role changes, booking status changes, payment confirmations/reversals/adjustments, document approvals/rejections, and visa-status changes — consistent with the `ActivityLog`/`AuditLog` entities in blueprint Section 14.9.
- Audit records are append-only; no role can modify or delete them (blueprint Section 4.2).

## Background Jobs

- When background jobs (reminders, scheduled status checks, email dispatch) are introduced, they must be idempotent, independently retryable, and must not perform actions a synchronous request path can't also validate (e.g., a reminder job must not bypass the same status rules the API enforces).

## No Secret or Sensitive-Error Exposure

- Never expose environment secrets, API keys, or credentials in responses, logs visible to lower-privileged roles, or client-side code.
- Sanitize error messages returned to non-admin roles.
