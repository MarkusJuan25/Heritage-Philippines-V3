# Heritage Philippines V3 — Environment Configuration Guide

## Document Status

- Project: Heritage Philippines V3
- Status: Active — Phase 1 environment-configuration standard
- Phase: Phase 1 — Project Foundation
- Last updated: July 22, 2026
- Authority: This document implements `docs/adr/ADR-001-technology-stack.md` and `.claude/rules/validation-deployment.md`. It does not override the blueprint, task board, or ADR — where this guide and any of those documents conflict, the higher-authority document governs and the conflict should be flagged rather than silently resolved.
- Companion documents: `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md` (Sections 2.1, 4.1, 10.3, 12.2, 12.3, 14.9, 15.5), `docs/HERITAGE_V3_TASK_BOARD.md` (Phase 1 and Phase 6), `docs/adr/ADR-001-technology-stack.md`, `.claude/rules/database-security.md`, `.claude/rules/backend.md`, `.claude/rules/validation-deployment.md`, `README.md`.

---

## 1. Purpose and Scope

This document defines the **environment configuration strategy** for Heritage Philippines V3: how local, staging, and production are kept isolated; who owns configuration in each; how environment variables are named; how secrets are generated, stored, rotated, revoked, and responded to if exposed; and the boundaries that apply once a database, authentication, transactional email, and private object storage are implemented.

It is a **standard to build against**, not an implementation. Consistent with the Phase 1 checklist in `docs/HERITAGE_V3_TASK_BOARD.md`, this document does not itself:

- implement authentication or session handling,
- create a database connection, Prisma schema, or migration,
- configure a real database, storage bucket, or email provider,
- create CI workflows or a deployment pipeline,
- or select a final hosting, database, storage, or email vendor (all remain deferred per ADR-001's "Items Intentionally Deferred").

Each of those proceeds under its own Phase 1 (or later) checklist item and completion gate. This guide exists so that when each of those items is implemented, the team is not inventing naming, isolation, or secret-handling conventions ad hoc, feature by feature.

Everything here applies to the single V3 Next.js modular-monolith application (admin dashboard, client portal, and API layer) described in ADR-001. The V2 public site's own environment configuration is out of scope until the V2 repository is inspected and an integration/migration plan is approved (blueprint Section 2.1; ADR-001).

## 2. Current Implementation State

As of this document:

- **`DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` are now required, server-only environment variables**, documented in `apps/web/.env.example`. Authentication (Better Auth, database-backed sessions, role guards) and PostgreSQL/Prisma integration are implemented — this is no longer a bare scaffold.
- **The database schema currently has 12 locally applied migrations** (`apps/web/prisma/migrations/`), applied to the local `heritage_v3_dev` and/or disposable `heritage_v3_test` databases only. **Staging and production migration application remain unverified and are not claimed** — no migration has been confirmed applied to either environment.
- **GitHub Actions CI exists and runs the repository quality gate** (`.github/workflows/ci.yml`): formatting, lint, type check, tests, and build, on every pull request and push to `main`. It does not deploy anywhere and does not touch a real database.
- **A provider-neutral deployment-pipeline skeleton now exists** (`.github/workflows/deploy-reusable.yml`, `deploy-staging.yml`, `deploy-production.yml`) — see Section 12 for what it does and, more importantly, does not yet do. **No real staging or production deployment target is configured**, and none of these workflows can currently deploy, migrate, or verify a deployed environment; each unimplemented step fails closed by design.
- **Email and private object storage remain unimplemented.** Sections 10–11 below describe planned boundaries for each, not implemented behavior.
- **`GET /api/health` remains a liveness-only check** (`apps/web/src/app/api/health/route.ts`), returning service name, status, and timestamp. It does not verify database, storage, or email connectivity.
- `NODE_ENV` is managed entirely by Next.js tooling (`next dev`, `next build`, `next start`) and is not set or read manually anywhere in this codebase.

The rest of this document is forward-looking strategy. Section headings below are written as durable standards; where a section describes something not yet built, it says so explicitly rather than implying it already exists.

## 3. Environment Isolation: Local, Staging, Production

Three environments are recognized, matching ADR-001's "Staging and production deployment shape." Each must have its own credentials, database, object storage, and email configuration — nothing is shared across environments.

| Aspect | Local | Staging | Production |
| --- | --- | --- | --- |
| Purpose | Individual development and manual verification | Pre-release verification (`.claude/rules/validation-deployment.md`); internal MVP target (Sept 30, 2026) | Live client and staff usage (target: Oct 31, 2026) |
| Who runs it | Each developer, on their own machine | The team, via the deployment pipeline (Phase 1 later item) | The team, via the same pipeline, gated separately |
| Config file | `.env.local` (gitignored; per developer) | Environment variables set on the staging deployment target | Environment variables set on the production deployment target |
| Data | Disposable, developer-owned; never real client data | Realistic but non-production data; never a copy of live client PII/payment/document data without an approved anonymization step | Real client data; full security/privacy controls apply |
| Database | A local PostgreSQL instance the developer owns and can freely reset | A dedicated managed PostgreSQL database, isolated from production | A dedicated managed PostgreSQL database, isolated from staging |
| Object storage | Local stub or a small non-shared developer bucket, once storage is implemented (Phase 4) | A dedicated private bucket/container | A dedicated private bucket/container, never shared with staging |
| Email | Sandbox/test mode; must never send to real client addresses | Sandbox mode or a restricted test-recipient allowlist; must never send to real client addresses | Live sending domain and credentials |
| Build | Built and run ad hoc by the developer | Its own build, from its own environment values | Its own build, from its own environment values |

**Why staging and production each need their own build, not a promoted artifact:** Next.js inlines any `NEXT_PUBLIC_*` variable into the compiled JavaScript bundle at build time (Section 6). If staging and production ever differ in a `NEXT_PUBLIC_*` value (for example, a public API base URL), a single build cannot be reused across both — each environment must be built from its own configuration. This also shapes the rollback expectations in Section 17.

Hostinger-managed Node.js/Next.js hosting (or an equivalent VPS-class host, per ADR-001) remains a practical target under this model: each environment is one persistent Next.js (`next start`) process with its own environment variables, requiring no infrastructure beyond what ADR-001 already assumes.

## 4. Configuration Ownership

Blueprint Section 15.5 classifies a full in-app System Settings UI as post-MVP; no in-app configuration screen exists yet. Until one does, environment and secret configuration is an **infrastructure responsibility held outside the application** — by the project owner and/or the designated technical approver referenced in ADR-001's approval requirements. This is distinct from the in-app System Administrator role (blueprint Section 4.1), which governs in-application platform administration once staff accounts and roles exist (a separate, currently unchecked, Phase 1 item); the two must not be conflated.

- **Local** configuration is owned by each individual developer. Nothing in a developer's `.env.local` is shared with, or authoritative for, any other environment.
- **Staging** configuration is owned by the team collectively, but changed deliberately per Section 18 — staging is a verification environment (`.claude/rules/validation-deployment.md`), not a scratch space.
- **Production** configuration changes are restricted to the smallest set of named individuals who need direct access, and follow the review process in Section 18.
- Consistent with `.claude/rules/database-security.md` ("Administrator actions on sensitive data are always attributable to a specific account"), no environment's secrets are held under a shared or generic login — access is per named individual, even at infrastructure level.

## 5. Environment-Variable Naming Convention

- **Casing:** `UPPER_SNAKE_CASE` for every application-defined variable.
- **Domain prefix:** prefix by infrastructure concern, not business feature, since database/auth/email/storage are cross-cutting: `APP_` (application/runtime-level), `DATABASE_`, `AUTH_`, `EMAIL_`, `STORAGE_`.
- **Suffix convention:** `_URL` (connection strings, endpoints), `_SECRET` (symmetric secret or signing key), `_KEY` (API key), `_TOKEN` (bearer/access token), `_BUCKET` (object-storage bucket/container name), `_REGION`, `_FROM` (sender address/identity).
- **Framework- or library-mandated names are used as-is**, even if they don't match the prefix convention above — for example, Prisma conventionally reads `DATABASE_URL` directly; fighting a library's documented expected name creates fragility for no benefit. Where this happens, it should be called out in the variable's own comment in `.env.example` so the exception is visible, not silently inconsistent.
- **`APP_ENV` distinguishes staging from production; `NODE_ENV` does not.** `NODE_ENV` controls framework/runtime behavior (`development`, `test`, or `production`). A production-mode Next.js build (`next build`/`next start`) may be deployed to either staging or production, so `NODE_ENV` alone cannot tell those two apart — `APP_ENV` identifies the actual deployment environment instead. Anything that needs to behave differently between staging and production specifically (e.g., email sandbox mode, verbose logging) should branch on a separate `APP_ENV` variable with values `local`, `staging`, or `production`, not on `NODE_ENV`. `APP_ENV` is a convention introduced by this document; no code reads it yet.
- Never encode a secret value, or part of one, inside a variable **name**. Names describe purpose; values hold secrets.

## 6. Server-Only vs. Browser-Exposed Variables

Next.js draws this line via a mandatory, framework-enforced prefix: any variable named `NEXT_PUBLIC_*` is inlined into the client-side JavaScript bundle at build time and is downloadable by anyone who loads the page. Any variable without that prefix stays server-only and is never sent to the browser.

Rules that follow from this:

- **Default to server-only.** Only prefix a variable with `NEXT_PUBLIC_` when its value is genuinely safe for public disclosure (e.g., a public API base URL, a public asset/CDN URL).
- **Never put a secret behind `NEXT_PUBLIC_`, even temporarily.** Database URLs, session/signing secrets, API keys, and access tokens must never carry this prefix. Once shipped in a build, a leaked `NEXT_PUBLIC_` value cannot be "taken back" without a new build and redeploy (Section 7.5 for the exposure-response process if this happens by mistake).
- Because these values are compiled in at build time, not read at server runtime, changing one requires a rebuild and redeploy — it cannot be hot-patched by editing a running server's environment.
- **Current state:** no `NEXT_PUBLIC_*` variable exists in this codebase yet. When one is introduced, its purpose and the fact that it is intentionally public must be documented at the point it's added (`.claude/rules/validation-deployment.md`, "Environment Variables").

## 7. Secret Lifecycle

Applies to every server-only secret: database credentials, the future auth/session secret, email provider API keys, and object-storage access credentials.

### 7.1 Generation

- Secrets are generated using a cryptographically secure random generator (e.g., the vetted auth library's documented key-generation command, or a standard cryptographic RNG) — never hand-typed, never derived from a predictable value (project name, date, incrementing counter).
- Each environment gets its own independently generated secret. A staging secret is never reused in production or vice versa, and a secret is never reused across two different purposes (e.g., the session secret is never also used as a webhook-signing secret).

### 7.2 Storage

- Local: in `.env.local`, gitignored, never committed (`.gitignore` already excludes `.env`, `.env.local`, and `.env.*.local`; `.env.example` files are intentionally tracked and must never contain real values).
- Staging and production: in that environment's own server-side environment-variable configuration (the hosting platform's environment-variable mechanism), or a dedicated secrets manager if one is adopted later. No secret is ever committed to source control, written into a build artifact's source, or placed in a world-readable file on the host.
- Provider-agnostic by design: this document does not mandate a specific secrets-manager product, consistent with ADR-001 deferring final hosting/provider selection and this document's requirement to avoid provider lock-in.

### 7.3 Rotation

- Every secret is rotated on a defined schedule once that cadence is decided (currently open — see Section 19) **and** immediately whenever an event-based trigger applies:
  - a staff member with access leaves the team or changes role,
  - a provider reports a breach or credential-stuffing risk,
  - a secret is suspected or confirmed exposed (Section 7.5).
- Rotation is performed per environment independently; rotating a production secret does not require (and should not accidentally trigger) rotating staging's.

### 7.4 Revocation

- Revocation is immediate and unconditional once triggered (offboarding, suspected compromise, provider advisory) — it is not scheduled or batched with routine rotation.
- Revoking a secret must not silently break the running application without a plan: the replacement secret is generated and deployed as part of the same action wherever the running service depends on it (e.g., revoking a database credential requires the new credential to be deployed before or atomically with the old one's revocation).

### 7.5 Exposure Response

If a secret is committed to git, printed in a log, pasted into chat/email, or otherwise exposed:

1. **Contain first, investigate second** — rotate or revoke the exposed secret at its source immediately, before confirming whether it was actually misused.
2. **Scope the exposure** — identify what the secret could access and how long it was exposed (e.g., how long it sat in a public commit, CI log, or shared channel).
3. **Invalidate dependent state** — if a session/auth secret was exposed, invalidate active sessions so previously issued tokens can't be replayed; if a database or storage credential was exposed, check that resource's access logs for the exposure window.
4. **Audit** — review the relevant `AuditLog`/`ActivityLog` entries (blueprint Section 14.9) and the provider's own access logs for suspicious activity during the exposure window, once those systems exist.
5. **Remediate the leak vector** — remove the secret from git history if committed (coordinated carefully, since history rewrites affect every clone), scrub it from CI logs, and ask recipients of any chat/email copy to delete it.
6. **Record the incident** — what leaked, when, the response taken, and rotation confirmation. This feeds the not-yet-defined incident/breach-response process tracked as open decision D-004 in `docs/HERITAGE_V3_DECISIONS_LOG.md`.
7. **Notify** — until D-004 (Philippine privacy/compliance posture) is resolved, notify the project owner/designated technical approver immediately; formal external notification obligations are governed by whatever D-004 ultimately decides.

## 8. Database Configuration Boundaries

Database schema and migration implementation is a separate, not-yet-started Phase 1 checklist item (`docs/HERITAGE_V3_TASK_BOARD.md`: "Implement database schema and reviewed migrations from the approved Phase 0 entity plan"). This section states the boundary the eventual implementation must satisfy, without asserting that a database, schema, or Prisma setup exists yet:

- Connection string variable: `DATABASE_URL` — the project's conventional Prisma variable name, to be referenced explicitly through `env("DATABASE_URL")` in the future Prisma schema once one is created. Prisma does not inherently mandate this exact name (Section 5's exception rule).
- One PostgreSQL instance/database per environment; local, staging, and production are never pointed at the same database.
- Local database contents are disposable and developer-owned; a developer may install and manage it however they prefer. No real client data is ever loaded into a local database.
- Staging's database is never a raw production copy; if realistic data volume is needed for staging verification, it must be synthetic or explicitly anonymized — never a direct restore of production PII, payment, or document data.
- Migrations are additive and reviewed before being applied to any shared environment (`.claude/rules/database-security.md`; Section 13 below).
- Monetary columns use exact-decimal types (`NUMERIC`), never floating point, per ADR-001 and `.claude/rules/database-security.md` — this is a schema-design rule, not an environment-configuration one, but it constrains how `DATABASE_URL`-connected code is written once implemented.

## 9. Authentication / Session-Secret Boundaries

Authentication implementation and library selection are separate, not-yet-started Phase 1 items (ADR-001 defers "Specific authentication/security library selection"). This section states the boundary the eventual implementation must satisfy, without asserting final variable names:

- The session/signing secret is server-only, never `NEXT_PUBLIC_`, generated per Section 7.1, and unique per environment.
- It is never logged, never returned in any API response, and never derivable from data a database read alone could expose (`.claude/rules/database-security.md`).
- Custom cryptography, password hashing, or session-token schemes are not implemented from scratch — ADR-001 requires a vetted, actively maintained library, selected after reviewing its official documentation, before this boundary is implemented.
- Illustrative naming (not final): something like `AUTH_SESSION_SECRET`. The exact variable name(s) are finalized when the auth library is selected and documented in `apps/web/.env.example` and this guide at that time, per `.claude/rules/validation-deployment.md`'s "Environment Variables" rule.
- Staging and production session secrets are independent; rotating one never invalidates the other's sessions.

## 10. Transactional-Email Boundaries

Outbound transactional email (portal invitations, payment reminders, message notifications) is a later Phase 3/4 item (ADR-001: "first needed for portal invitations in Phase 3; extended... in Phase 4"). Boundaries for when it's implemented:

- Email provider API keys are server-only secrets, one set per environment, never shared between staging and production.
- Local and staging must run in a sandbox/test mode or send only to an explicit allowlist of test recipients — neither may ever send real notifications to real client addresses.
- Email is outbound notification only for the MVP (blueprint Section 10.3; ADR-001); it is not a system of record for conversations, so no environment configuration in this area should be designed to receive or parse inbound mail.
- Sensitive content (documents, full payment details, full private conversation contents) must never be placed in an email body or attachment (blueprint Section 12.3; ADR-001) — this is an application-logic rule that email environment configuration must not be used to work around (e.g., no "just email the file" fallback modes, even in non-production environments).
- Provider selection remains deferred (ADR-001); the eventual adapter should be confined to the email feature's own module (per `.claude/rules/architecture.md`'s feature-ownership rule) so a future provider swap touches one boundary, not call sites scattered across the codebase.

## 11. Private-Object-Storage Boundaries

Document/attachment storage is a Phase 4 item (ADR-001: "alongside the Documents feature"). Boundaries for when it's implemented:

- One private bucket/container per environment; local, staging, and production are never pointed at the same bucket.
- Storage access credentials are server-only secrets, generated and rotated per Section 7, independent per environment.
- No sensitive file is ever exposed via a permanent public URL — only backend-issued, signed, expiring download links (blueprint Section 12.3; ADR-001).
- File-type/size validation and malware scanning happen before a file is persisted, regardless of environment.
- Replaced documents are retained (versioned), not deleted, consistent with blueprint Section 12.2 — this is an application/data-model rule that storage configuration must support (e.g., no environment should be configured to overwrite-in-place).
- Provider selection remains deferred; as with email, the eventual adapter should live behind the Documents feature's own module boundary to avoid provider lock-in.

## 12. CI/CD Secret Handling

ADR-001 specifies GitHub Actions as the CI foundation. `.github/workflows/ci.yml` (the Phase 1 "CI basics" checklist item) exists and runs the repository's quality gate on every pull request and push to `main`; it deploys nowhere and touches no real database. Standard for a deploy workflow, now realized only as the fail-closed skeleton described below:

- Secrets are stored as GitHub Actions encrypted secrets, scoped per GitHub Environment (`staging`, `production`) rather than as repository-wide secrets, so a workflow job only receives the secrets for the environment it's actually deploying to.
- Production's GitHub Environment should require review/approval before a workflow can use its secrets, giving a human gate on production deploys consistent with Section 18.
- Workflow YAML never contains a secret value directly; it only references `secrets.*` / environment-scoped secret names.
- Workflow steps must not print secret values to logs (GitHub Actions masks known secret values automatically, but commands that transform or re-encode a secret can defeat that masking — avoid doing so).
- CI does not hold standing, always-available access to production secrets outside of an actual gated deploy job.
- CI/deploy credentials themselves (e.g., a deploy token to the hosting provider) are treated as secrets under Section 7 — generated with least privilege, rotated on the same triggers, and revoked immediately on offboarding.

### 12.1 Current Deployment-Pipeline Skeleton (Phase 1)

Three workflow files implement the Phase 1 deployment-pipeline-skeleton checklist item, provider-neutrally and fail-closed:

- `.github/workflows/deploy-reusable.yml` — a `workflow_call`-only reusable workflow. Its first job (`activation-guard`) always fails on purpose, before checking out the repository, binding to any GitHub Environment, or referencing any secret. Its second job (`deployment-pipeline`) `needs` that guard with default (non-`always()`) dependency behavior, so it is always skipped today; it exists only to document, with real repository commands where they already exist and explicit fail-closed placeholders where they don't, the order a future real deployment will follow.
- `.github/workflows/deploy-staging.yml` and `.github/workflows/deploy-production.yml` — `workflow_dispatch`-only entry points with no logic of their own, each calling the reusable workflow with a hard-coded literal environment name (`staging` or `production` respectively) — never a user-selectable input, and never triggered by a push, merge, or schedule.
- **This repository change does not configure or claim that any GitHub Environment secret currently exists.** The activation guard references no secret or GitHub Environment; the currently unreachable deployment job's secret references document values intended for future environment-scoped configuration. No deployment, database migration, or post-deployment health check can currently occur through these workflows — every such step is an explicit, independently fail-closed placeholder.
- **GitHub Environments (`staging`, `production`) and any production approval/review rule remain external, manually configured repository settings** that cannot be verified from this document or from the repository's own files — this guide does not assert either Environment, or any protection rule on it, currently exists.
- Activating any of this for a real target — selecting a hosting/database/storage/email provider, populating real environment-scoped secrets, and replacing the fail-closed placeholders with real commands — is explicitly out of scope for this checkpoint and belongs to a later, separately authorized implementation stage.

## 13. Migration Safety

(Elaborates `.claude/rules/database-security.md` and `.claude/rules/validation-deployment.md` for the environment-configuration context; does not change those rules.)

- Migrations are additive and backward-compatible wherever possible; destructive changes (dropping a column/table with live data) require an explicit backup and rollback plan before being applied anywhere beyond local.
- Every migration is reviewed against the currently-running code path it will affect before being applied to staging, and again before production — a migration reviewed once for staging is not automatically re-applied to production without that second review, since production's live-data shape may differ.
- Migrations run through the same environment isolation as everything else: a staging migration never runs against the production database, and a local migration never runs against either.
- No migration is applied to production without a preceding, successful staging pass, per `.claude/rules/validation-deployment.md`'s "Staging Before Production" rule.

## 14. Logging and Observability

- **Current state:** no logging framework or observability tooling is chosen yet. `GET /api/health` (Section 2) is the only implemented observability surface.
- Once logging is implemented, logs are structured (e.g., JSON), written to stdout/stderr so any log destination can consume them without coupling the application to a specific vendor (avoiding provider lock-in), and never contain passwords, tokens, full payment details, full document contents, or other sensitive values (`.claude/rules/backend.md`, `.claude/rules/database-security.md`).
- Log verbosity may vary by `APP_ENV` (Section 5) — e.g., more verbose in local/staging than production — but redaction rules apply identically in every environment; nothing sensitive is "allowed through" in non-production logs.
- Centralized log aggregation and alerting/monitoring tooling selection is deferred; this document does not name a vendor so the choice can be made without lock-in when observability is actually implemented.
- Log retention duration is unresolved pending the privacy/compliance review tracked as decisions log entry D-003/D-004 — no retention period should be invented ahead of that review.

## 15. Backup and Restore Expectations

- **Current state:** no database, storage, or backup mechanism exists yet; this section states the expectation for when they do, and is the standard `docs/HERITAGE_V3_TASK_BOARD.md` Phase 6's "backup/restore verification" task will be checked against.
- Production (and, where practical, staging) rely on the managed PostgreSQL provider's automated backups, once a provider is selected; exact frequency/retention are set when that provider is chosen and documented here at that time.
- A restore has been actually tested (not merely assumed to work) before Phase 6 sign-off and before any destructive production change (`.claude/rules/validation-deployment.md`, "Rollback and Backup").
- Private object storage should use a provider offering built-in versioning/redundancy where available, in addition to the application-level document-version retention already required by blueprint Section 12.2.
- Backup restore access is limited to the same small set of named individuals described in Section 4 — a restore is a destructive-adjacent operation and is never performed casually.

## 16. Deployment Verification

- `GET /api/health` is the existing baseline liveness check and should be the first thing confirmed after any deploy, to any environment, once a deployment pipeline exists.
- As dependencies are added (database, storage, email), the health check — or an equivalent readiness check — should be extended to verify those connections, rather than only confirming the Node process started. That extension is future work, not part of this documentation task.
- Post-deployment smoke testing exercises the core paths relevant to that release (`.claude/rules/validation-deployment.md`) — at minimum, once they exist: login, the specific feature shipped, and any flow it could plausibly affect.
- Staging verification is a prerequisite for production deployment, never skipped, per `.claude/rules/validation-deployment.md`'s "Staging Before Production" rule.

## 17. Rollback Expectations

- A rollback path is confirmed **before**, not during, a production deployment (`.claude/rules/validation-deployment.md`; ADR-001).
- Because `NEXT_PUBLIC_*` values are compiled into a specific build (Section 3, Section 6), rolling back means redeploying the **previous release's build**, not just reverting a runtime environment-variable value — a shared runtime config cannot "undo" something baked into an already-shipped bundle.
- Any migration applied alongside a release is designed, where possible, so the previous release's code can still run against the post-migration schema — i.e., migrations are additive/backward-compatible (Section 13) specifically so a code rollback doesn't require an accompanying destructive schema rollback.
- Rollback is triggered by a named decision-maker (the same ownership group as Section 4/18), not performed unilaterally mid-incident by whoever happens to be online, except where an agreed incident-response process (future work) says otherwise.

## 18. Configuration-Change Review

- Every new environment variable is documented at the point it's introduced — its purpose, and whether it's required in local, staging, and production — in `apps/web/.env.example` (with a comment) and, for anything durable enough to affect the strategy in this document, here as well (`.claude/rules/validation-deployment.md`, "Environment Variables").
- Changes to **staging** configuration are made deliberately and are visible to the team (e.g., called out in the PR or change that requires them), not edited ad hoc directly on the running staging host without a corresponding documented change.
- Changes to **production** configuration require the same discipline plus a second person's review before being applied, mirroring code review — no undocumented, unreviewed, single-person edit to a live production secret or variable.
- A configuration change is never bundled silently inside an unrelated code change; if a change requires a new or modified environment variable, that requirement is called out explicitly in the change that introduces it.

## 19. Open Decisions and Future Work

The items below are implementation-planning details this document surfaces but does not resolve. None are new stakeholder-level decisions, so none are added to `docs/HERITAGE_V3_DECISIONS_LOG.md` as part of this document.

**Why `APP_ENV` (Section 5) is not logged as a decision:** it is an implementation-level naming convention, not a stakeholder-level decision. It is currently unused — no code reads it yet — and freely renameable at zero cost if the team later prefers a different name. It supports the environment isolation ADR-001 and the blueprint already require, without changing product scope, financial rules, legal exposure, role boundaries, ADR-001 itself, or the approved blueprint; it only fills in a mechanism ADR-001 leaves open (how staging is told apart from production at runtime). The existing decisions-log entries (D-001 through D-010) each gate a choice that would materially change scope, financial semantics, legal exposure, or role boundaries — `APP_ENV` does none of that, so it does not meet the bar for an entry there.

- Exact secret-rotation cadence (Section 7.3) — no schedule is set yet.
- Whether a dedicated secrets manager is adopted, or hosting-platform environment variables remain sufficient — deferred to avoid provider lock-in ahead of need.
- Final hosting provider, managed-PostgreSQL provider, private-object-storage provider, and transactional-email provider (all deferred per ADR-001's "Items Intentionally Deferred").
- Specific authentication/session library, and therefore the final auth/session environment-variable names (Section 9).
- Backup frequency/retention and restore-drill cadence (Section 15) — set once a database provider is chosen.
- Log retention duration and observability/alerting tooling (Section 14) — blocked on the same privacy/compliance review as D-003/D-004.
- Formal incident/breach-notification process (Section 7.5) — blocked on D-004 (Philippine privacy/compliance posture).

---

This document should be updated whenever a real environment variable, secret category, or infrastructure boundary is introduced, so it stays a true reflection of the system rather than a snapshot of Phase 1 intentions.
