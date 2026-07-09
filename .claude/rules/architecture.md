# Architecture Rules

## Status of Technology Decisions

The technology stack is accepted. `docs/adr/ADR-001-technology-stack.md` (Status: Accepted, July 9, 2026) records the stack: TypeScript, Node.js, Next.js, PostgreSQL, Prisma, Zod, pnpm, modular monolith. `docs/HERITAGE_V3_DECISIONS_LOG.md` D-001 reflects this as Accepted, and the corresponding `docs/HERITAGE_V3_TASK_BOARD.md` Phase 1 checklist item is checked. Scaffolding, package installation, and schema creation each still proceed only under their own Phase 1 checklist item and completion gate — ADR acceptance authorizes the stack decision, not any specific implementation step ahead of its own checklist entry.

The Heritage Philippines V2 codebase is the reference for the public site's existing stack, but it is not present in this repository — confirm its actual technology by inspecting the V2 repository directly when reuse/migration work begins, rather than assuming.

## Application Boundaries

Treat these as separate concerns, even if they eventually share a monorepo or framework:

- **Public site (V2)** — presentational, content-driven, minimal business logic.
- **Admin dashboard** — staff-only, role- and assignment-gated.
- **Client portal** — client-only, strict per-client ownership.
- **Backend / API layer** — the only place business rules and data access are implemented; UI layers call it, never the database directly.
- **Database** — the system of record; schema mirrors the entities in blueprint Section 14.
- **Authentication** — a single shared identity system across public site, admin dashboard, and client portal, issuing role-aware sessions/tokens.
- **Storage** — document and attachment storage, separate from application code, with access mediated by the backend (never direct public bucket URLs for sensitive files).
- **Email** — outbound notification delivery (invitations, payment reminders, message notifications); not a source of truth for conversations in the initial release (see blueprint Section 10.3).
- **Deployment** — staging and production environments are distinct; see `validation-deployment.md`.

## Modular, Feature-Oriented Organization

- Organize code by feature/domain (leads, proposals, bookings, payments, documents, visa, support) rather than by technical layer alone.
- Each feature module owns its own validation schemas, service logic, and data-access calls; cross-feature reuse goes through explicit shared contracts, not direct reach-through into another feature's internals.

## Shared Contracts and Validation Boundaries

- Define request/response and domain-object shapes once per feature and reuse them across frontend and backend rather than duplicating field lists.
- Validate all external input (HTTP requests, uploaded files, webhook payloads) at the boundary before it reaches business logic.

## Business Logic Placement

- Business logic (role checks beyond basic auth, balance calculations, status-transition rules, duplicate detection, assignment resolution) must live in the service/domain layer — never directly inside UI components or route handlers.
- Route handlers and UI components should only: parse/validate input, call a service, and shape output.

## Avoid Premature Abstraction

- Do not introduce a shared abstraction, plugin system, or generic framework-within-the-framework until at least two concrete features need it.
- Do not add a dependency to solve a problem that a few lines of code already solve.

## V2 Compatibility Considerations

- Preserve V2's public URLs, SEO structure, and production-tested behavior; changes to V2 are scoped to what dashboard integration, auth, or content management actually requires (blueprint Section 2.1).
- Any shared authentication or navigation change touching V2 must not break its existing public experience.
