# ADR-001: Technology Stack for Heritage Philippines V3

## Status

Accepted

Accepted by the project owner on July 9, 2026, based on the completed independent architecture review and final documentation verification, which found no critical, high, medium, or blocking findings. This ADR authorizes the recommended technology stack. Application scaffolding, package installation, database schema creation, authentication implementation, and deployment setup each still proceed only under their own Phase 1 completion gate in `docs/HERITAGE_V3_TASK_BOARD.md` — accepting this ADR authorizes the stack decision, not any specific implementation step ahead of its checklist.

## Date

July 9, 2026

## Context

Heritage Philippines V3 extends the approved Heritage Philippines V2 public website into a secure operations platform with:

- the existing public website experience preserved;
- a staff-only admin dashboard;
- a client-only portal;
- backend-owned business rules for leads, clients, proposals, bookings, payments, documents, visa cases, support, notifications, and audit logs;
- a relational database matching the approved conceptual entity plan;
- sensitive document storage mediated by backend authorization; and
- staging and production environments.

The approved Phase 0 blueprint closes the structure and workflow baseline, but the technology stack remains unaccepted until an ADR is reviewed and approved. The V2 public-site stack is a compatibility input, not an approved V3 stack. The V2 repository is not present here, so its exact technology must be inspected before any public-site reuse or migration work.

This ADR favors the smallest secure architecture that can satisfy the approved MVP and be maintained by a small development team. It avoids premature microservices, broad shared abstractions, and unnecessary infrastructure.

## Decision Drivers

- Preserve the stable V2 public website, including URLs, SEO structure, mobile behavior, and production-tested public flows.
- Support strict role-based, assignment-based, and client-ownership authorization.
- Keep business rules in backend service/domain layers, not in UI components or direct database access.
- Use shared request/response/domain validation contracts instead of duplicated field lists.
- Support exact monetary values and server-side balance calculations.
- Support append-only audit logging and operational activity history.
- Store sensitive documents outside web-servable paths with signed or expiring access.
- Keep staging and production separate.
- Keep the stack learnable and maintainable for a small team.
- Avoid accepting dependency versions before they are checked against official documentation during implementation planning.

## Application Boundaries

V3 should be implemented as a modular monolith first. The following boundaries remain separate even if they live in one repository and one V3 deployable application:

- **Public site:** V2-compatible public experience. It should remain stable and should not be rewritten until the V2 repository has been inspected and a specific migration or integration plan is approved.
- **Admin dashboard:** staff-only UI; every view and action is gated by role and assignment.
- **Client portal:** client-only UI; every record access is scoped to the authenticated client's ownership.
- **Backend/API layer:** the only place business rules, authorization policies, status transitions, balance calculations, audit logging, and data access orchestration are implemented.
- **Database:** PostgreSQL system of record for relational business data and audit metadata.
- **Authentication/session system:** one shared identity model for staff and clients, with role-aware sessions and per-request authorization checks.
- **Storage:** private document and attachment storage; access is always mediated by backend authorization and signed or expiring links.
- **Email:** outbound notification delivery only for the MVP; portal messages remain the system of record.
- **Deployment:** distinct local, staging, and production configurations for V3. The existing V2 public website may remain separately deployed until its repository is inspected and a public-site integration or migration plan is approved.

UI code must not import repositories or query the database directly. Server-rendered pages may call application services only through the same validation and authorization boundaries used by API handlers.

## Options Considered

### Option A: TypeScript modular monolith with Next.js, PostgreSQL, Prisma, and shared schema validation

One TypeScript codebase uses Node.js as the runtime, Next.js for public/admin/client web surfaces and API route handlers, PostgreSQL as the relational database, Prisma for database access and migrations, and shared schema validation for API contracts.

This option keeps one language across frontend and backend, minimizes infrastructure, and still supports the required internal boundaries.

### Option B: Separate React frontend and NestJS API service

A React SPA or SSR frontend is deployed separately from a NestJS backend API. The backend owns all business logic, authentication, authorization, persistence, and audit logging.

This option gives strong physical separation between frontend and backend, but adds more deployment units, more cross-service configuration, more local development setup, and more coordination overhead than the MVP needs.

### Option C: Laravel full-stack application with PostgreSQL

A PHP/Laravel application provides server-rendered pages, backend services, authentication, migrations, queues, and PostgreSQL persistence.

This option is credible for a business operations system and has strong built-in conventions. It is less aligned with the likely V2 frontend reuse path unless V2 is also PHP/Laravel, which has not been verified. It would also require the team to maintain a separate PHP stack if the public-site frontend remains JavaScript-based.

## Recommended Technology Stack

- **Primary programming language:** TypeScript for application code; SQL for reviewed database queries and migrations where needed.
- **Runtime:** Node.js active LTS at the time of scaffolding. Use the standard Node.js runtime for authenticated API, ORM, document, and audit paths; do not depend on edge runtime behavior for database-backed business workflows.
- **Package manager and workspace strategy:** pnpm with a single lockfile and Corepack-managed package-manager metadata after acceptance. Use a monorepo-ready workspace, but begin with the fewest workspace packages needed. Extract shared packages only after real duplication appears across application boundaries.
- **Public-site compatibility:** preserve V2 behavior first. Inspect the V2 repository before deciding whether public pages are linked, proxied, incrementally migrated, or hosted beside the new dashboard/portal. The V3 stack does not by itself authorize rewriting V2.
- **Admin dashboard frontend:** Next.js with React and TypeScript, using server rendering where it improves security, performance, or initial load, and client components only where interactivity requires them.
- **Client portal frontend:** Next.js with React and TypeScript, sharing the design system and contract patterns with the admin dashboard while preserving strict client ownership checks.
- **Route-level access segregation (defense in depth):** Admin dashboard pages and API handlers live under an `/admin/**` path namespace and require an authenticated staff session; client portal pages and API handlers live under a `/portal/**` path namespace and require an authenticated client session scoped to that client's own records. A shared route-guard middleware enforces this namespace-level check as a first line of defense. Route guards are supplementary only — they narrow which broad category of identity may reach a namespace; final, resource-specific role, assignment, and client-ownership authorization always remains in the service layer per request, consistent with blueprint Section 4 and `.claude/rules/client-portal.md`.
- **Backend/API framework:** Next.js route handlers running on Node.js, organized behind explicit validation, auth, service, and repository layers.
- **API architecture:** resource-oriented JSON API endpoints for dashboard and portal workflows. Avoid GraphQL and broad RPC frameworks for the MVP unless a later ADR shows a concrete need.
- **Shared contracts and validation:** Zod schemas per feature for external input, response shapes, and domain DTOs where sharing is useful. TypeScript types are inferred from the schemas instead of duplicated manually.
- **Authentication and session strategy:** the application owns the identity, session, role, permission, assignment, client-ownership, and authorization boundaries, but must not build authentication security from scratch. Implementation must use a vetted, actively maintained authentication/security library selected after checking its official documentation. Custom cryptography, password-hashing algorithms, session-token primitives, or authentication protocols must not be implemented. Sessions should use secure, HttpOnly, SameSite cookies and database-backed session state unless the accepted library's documented secure pattern requires a different approved design. Staff and client accounts use the same identity model, with role-aware sessions and per-request authorization.
- **Role and permission enforcement:** server-side policy checks in the service layer, using role, assignment, and client-ownership rules from the blueprint. Middleware may perform coarse authentication checks, but application services must enforce resource-specific authorization.
- **Database engine:** PostgreSQL.
- **ORM/database access strategy:** Prisma for schema modeling, generated database client, and migrations; reviewed raw SQL may be used for reporting or complex queries where Prisma is not the right fit. Monetary values must use exact decimal handling in PostgreSQL and application code.
- **Monetary data handling:** Monetary values are stored in PostgreSQL using `NUMERIC` (or another exact-decimal column type) — never `FLOAT`/`DOUBLE PRECISION`. Inside the application, monetary values are represented with Prisma's `Decimal` type (or another exact-decimal representation) end to end and are never converted to a native JavaScript `number` for arithmetic. At API boundaries, monetary values are serialized as decimal strings (e.g., `"1250.00"`), not JSON numbers, so a client or transport layer cannot silently coerce them into floating point. Totals, remaining balances, payment allocation, refunds, and adjustments are always computed using exact-decimal arithmetic, never binary floating-point. Conversion between the stored decimal column, the application's decimal type, and the serialized API string happens only in explicit, reviewed service/API boundary code — never scattered ad hoc through the codebase.
- **Database migrations:** Prisma Migrate after ADR acceptance, with generated migrations reviewed before application. Migrations should be additive and backward-compatible where possible; destructive changes require backup and rollback plans.
- **Testing approach:** Vitest unit tests for validation and services, integration tests against a disposable PostgreSQL database for repository and API paths, component tests for key UI states, and Playwright end-to-end tests for critical staff/client flows once screens exist. Accessibility checks should be included for dashboard and portal UI.
- **CI foundation:** GitHub Actions after acceptance, initially running install, formatting/linting, type checking, unit/integration tests, migration validation, and production build once those commands exist.
- **File-storage boundary for sensitive documents:** private object storage with backend-issued signed or expiring links. Store metadata and authorization state in PostgreSQL; never expose permanent public bucket URLs for sensitive documents. File type/size validation and malware scanning are required implementation concerns.
- **Email-notification boundary:** a server-side transactional email adapter for portal invitations, payment reminders, and message notifications. Email is outbound notification only for the MVP; inbound synchronization remains deferred.
- **Staging and production deployment shape:** V3 initially targets one managed Node.js/Next.js modular-monolith application deployment, one managed PostgreSQL database, private object storage, and a transactional email provider per environment. The existing V2 public website may remain separately deployed until the V2 repository is inspected and a public-site integration or migration plan is approved. ADR-001 does not authorize rewriting or immediately migrating V2. Staging and production must use separate V3 credentials, databases, storage buckets/containers, and email configuration.
- **Logging and auditability:** structured server logs with sensitive-value redaction, plus application-level ActivityLog and append-only AuditLog records for the sensitive actions required by the blueprint.
- **Long-term maintainability:** feature-oriented modules for leads, proposals, bookings, payments, documents, visa, support, identity, and notifications. Avoid generic abstractions until at least two features prove the same need.

## Rationale

The recommended stack gives the project one main language, one V3 deployable application, and one relational database while still preserving the required architectural boundaries. TypeScript reduces duplicated frontend/backend shape definitions. Next.js can support the V3 admin dashboard, client portal, and API layer without forcing separate services, and can support public-site integration later if an approved V2 plan calls for it. PostgreSQL fits the relational domain model, audit history, assignments, status histories, payment records, and document metadata better than a document database.

Prisma is recommended because it gives a small team a typed database client, explicit schema, and migration workflow while still allowing raw SQL for cases where precise reporting or performance requires it. The recommendation does not treat prior mentions of Prisma as approval; it selects Prisma because it fits the approved entity model, migration needs, and TypeScript stack.

The modular monolith keeps operations simple for the MVP. The project can later split workloads only if real scaling, security, or organizational pressure justifies it.

## Security and Privacy Implications

- Authentication and authorization must be enforced on the server for every request.
- Authentication security must rely on a vetted, actively maintained library selected after official-documentation review; the project must not implement custom cryptography, password hashing, session-token primitives, or authentication protocols.
- The application remains responsible for identity, session, role, permission, assignment, client-ownership, and resource-specific authorization boundaries even when a library handles authentication primitives.
- Client ownership checks must scope data access by authenticated identity, not by client-supplied IDs.
- Assignment-based access must be enforced before returning admin data.
- Passwords and sensitive tokens must be hashed or otherwise stored so they cannot be replayed from database contents alone.
- Exact decimal handling is required for money; JavaScript binary floating-point numbers must not be used for financial arithmetic.
- Payment confirmation, reversal, refund, and adjustment operations, and document-replacement operations, must be idempotent — safe to retry without double-applying an effect (e.g., a duplicate refund request must not double-refund a payment) — using an idempotency key or equivalent safeguard, consistent with `.claude/rules/backend.md`'s idempotency rule.
- All API responses use a consistent error-response envelope (a stable shape such as `{ code, message, details? }`) across every endpoint. Error responses are role-aware and environment-aware: no response, in any environment or to any role, discloses stack traces, internal identifiers, infrastructure details, or sensitive authorization information to the client; lower-privileged roles receive sanitized messages even where a more privileged role might see additional operational detail, consistent with `.claude/rules/backend.md`'s consistent-error-response rule.
- Audit records must be append-only and attributable to a specific authenticated account.
- Logs must redact passwords, tokens, document contents, full payment details, and other sensitive data.
- Document files must live in private storage and be accessed through backend-authorized signed or expiring links.
- Email notifications must not include sensitive document attachments or full private conversation contents.
- Public inquiry and authentication endpoints need rate limiting and abuse controls during implementation.

## Deployment Implications

- The initial V3 deployment should be one Node.js/Next.js modular-monolith application deployment per environment, not a set of microservices.
- The existing V2 public website may remain separately deployed until V2 inspection and an approved public-site integration or migration plan. This ADR does not authorize rewriting or immediately migrating V2.
- Staging and production must be separate environments with separate V3 secrets, credentials, databases, private storage, and email configuration.
- The runtime must support Node.js active LTS, server-rendered web routes, API handlers, secure cookies, and database connectivity.
- The hosting environment must be VPS-class (or an equivalent deployment target) capable of running a persistent, long-lived Node.js process, with support for background/scheduled work, secure environment-variable configuration, application health checks, and controlled (non-destructive) deployments and restarts. A shared-hosting tier limited to a Passenger-managed or otherwise process-constrained Node.js runtime does not meet this requirement. This preserves Hostinger's VPS tier (or an equivalent VPS/managed-Node host from another provider) as a realistic deployment target without selecting a final hosting vendor; final hosting-provider and tier selection remains deferred (see Items Intentionally Deferred).
- Background work such as payment reminders, email dispatch, status checks, and malware scanning should be implemented with idempotent jobs or managed scheduled/background execution when those features are reached.
- Secrets belong in environment configuration or a secrets manager, never in committed files.
- Production deployment requires a rollback path, database backup/restore confidence, and post-deployment smoke tests.

## Development and Maintenance Implications

- The team must keep feature modules small and explicit rather than creating generic shared frameworks too early.
- Route handlers should stay thin: validate input, authenticate, authorize, call a service, and shape a response.
- Service methods should own business rules and audit writes.
- Resource-specific authorization stays in application services even when authentication/session primitives come from a vetted library.
- Repository/data-access modules should own database interaction but not business decisions.
- Shared validation schemas reduce drift between UI, API, and service layers.
- The public-site integration plan remains dependent on inspecting V2 directly.
- Dependency versions should be chosen and pinned only after checking official documentation at implementation time.

## Positive Consequences

- One primary language across frontend, backend, validation, tests, and contracts.
- Small operational footprint for the MVP.
- Strong fit for relational data, audit logs, assignments, and financial records.
- Clear path to server-side authorization and server-side balance calculations.
- Easier onboarding for a small team than separate frontend/backend stacks.
- Compatible with incremental public-site preservation instead of a forced rewrite.
- CI can start simple and grow with the application.

## Negative Consequences and Trade-offs

- A single framework can blur boundaries if the team allows UI, route, service, and repository code to mix.
- Next.js-specific conventions may influence architecture unless the project enforces the documented layer rules.
- Prisma migrations and generated SQL still require human review; the ORM does not remove database-design responsibility.
- Some background jobs and malware-scanning workflows may require managed job infrastructure or an additional worker later.
- Public-site compatibility cannot be fully confirmed until the V2 repository is inspected.
- V2 may need to remain on a separate deployment longer than the new V3 dashboard/portal stack, adding temporary operational coordination.
- A modular monolith can become large over time if feature boundaries are not maintained.

## Rejected Alternatives and Reasons

- **Microservices for dashboard, portal, auth, payments, documents, and notifications:** rejected for MVP because it adds deployment, observability, authentication, and data-consistency overhead before the project has scale pressure that justifies it.
- **Separate React SPA plus NestJS API as the default:** rejected for now because it increases infrastructure and local development complexity. It remains a credible future option if the API must serve multiple independent clients.
- **Laravel/PHP as the default full-stack framework:** rejected unless V2 inspection later shows strong PHP/Laravel reuse value. It is a credible business-app stack, but it may create a second technology family beside the likely JavaScript/TypeScript public-site ecosystem.
- **NoSQL document database as the system of record:** rejected because the approved domain relies on relational integrity, assignments, status histories, audit logs, and financial records.
- **Backend-as-a-service as the primary authorization/data layer:** rejected for the MVP because the blueprint requires explicit service-layer business rules, audit history, and assignment/client-ownership policies that should remain application-owned.
- **GraphQL or broad RPC framework for the MVP:** rejected because the current workflows are resource-oriented and can be served by simpler JSON endpoints with shared validation schemas.

## Items Intentionally Deferred

- Exact dependency versions and package scripts.
- Specific authentication/security library selection.
- Application folder names and workspace package boundaries.
- Scaffolding, `package.json`, lockfile, source code, database schemas, and migrations.
- Final V2 integration or migration plan until the V2 repository is inspected.
- Final hosting vendor, database provider, storage provider, and email provider procurement.
- Payment processor selection.
- Currency strategy acceptance; the Philippine-peso-only (PHP currency) proposal remains pending stakeholder approval.
- Retention periods and privacy/compliance posture.
- MFA, SSO, and advanced account-security features beyond the initial shared identity/session model.
- Inbound email synchronization, Gmail synchronization, Facebook Messenger, WhatsApp, and unified inbox.
- Full tours/content management, full System Settings UI, advanced BI, and nonessential customization.

## Approval Requirements

Before this ADR can become Accepted:

- management or the designated technical approver must approve the recommended stack;
- the team must confirm that the V2 public-site integration path is acceptable for the approved MVP;
- security/privacy reviewers must accept the authentication, authorization, storage, logging, and audit boundaries;
- the project owner must confirm that the stack is maintainable by the expected team;
- `docs/HERITAGE_V3_DECISIONS_LOG.md` D-001 must be updated from Proposed to Approved; and
- `docs/HERITAGE_V3_TASK_BOARD.md` must mark ADR review and acceptance complete.

Until then, this ADR is only a proposal and must not be used to scaffold the application.

## Follow-up Actions After Acceptance

After this ADR is accepted, and only after acceptance, each action below proceeds under its own phase gate in `docs/HERITAGE_V3_TASK_BOARD.md`. ADR acceptance alone does not authorize any of them.

### Immediate, pre-Phase-1-scaffolding

- Inspect the V2 repository and record the public-site compatibility plan.
- Select a vetted authentication/security library after checking its official documentation.

### Phase 1 — Project Foundation

- Initialize the approved package manager and workspace metadata.
- Create the application folder structure selected during scaffolding.
- Add the first `package.json` and lockfile.
- Document required environment variables for local, staging, and production.
- Configure TypeScript, formatting, linting, testing, and build scripts.
- Add initial CI using the real commands that exist in the repository.
- Create the initial database schema and first reviewed migration.
- Implement the authentication/session foundation.
- Implement the base role, permission, assignment, and client-ownership policy checks.
- Implement staff account, role, and assignment management needed to operate the six approved roles.
- Create the deployment pipeline skeleton for staging and production.

### Later phases

- Configure private document-storage boundaries (Phase 4, alongside the Documents feature).
- Configure the outbound email adapter boundary (first needed for portal invitations in Phase 3; extended for payment reminders and message notifications in Phase 4).
- Update validation/deployment documentation with the real commands and deployment workflow, as each phase introduces them.
