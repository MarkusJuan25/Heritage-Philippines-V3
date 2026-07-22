# CLAUDE.md — Heritage Philippines V3

## 1. Project Identity and Purpose

Heritage Philippines V3 extends the stable Heritage Philippines V2 public tourism website into a full operations platform: a secure admin dashboard for staff and a client dashboard/portal for travelers, connecting leads, bookings, payments, documents, visa assistance, and support into one system.

This repository is currently in **Phase 2 — Admin Dashboard Core**. Phase 1 — Project Foundation is complete: authentication, the PostgreSQL schema and migration history, staff account/role/assignment management, and Booking backend groundwork (creation, status transitions, staff assignment) are implemented and tested. The `/login` and `/dashboard` pages are a Phase 1 login/session verification surface only, not the admin dashboard described in blueprint Section 2.2. Lead, Client, Proposal / ROS, and real admin-dashboard workflow implementation remain incomplete and are Phase 2's active work; implementation proceeds under Phase 2's own task board checklist and completion gate.

## 2. Source of Truth

In order of authority for scope, architecture, and delivery decisions:

1. `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md` — the master blueprint: roles, domain model, lifecycles, payments, documents, database entities, MVP scope.
2. `docs/HERITAGE_V3_TASK_BOARD.md` — the phased plan: what phase is active, its scope, and its completion gate.
3. `docs/HERITAGE_V3_DECISIONS_LOG.md` and `docs/HERITAGE_V3_MANAGEMENT_FEEDBACK.md` — supplementary decision/feedback records, when populated.
4. This file and `.claude/rules/` — how to work inside the codebase day to day; they implement the blueprint, they do not override it.

If an instruction conflicts with the blueprint or task board, flag the conflict instead of silently choosing one.

## 3. Product Relationship

- **V2 public site** — the existing, stable public-facing site (homepage, tours, stories, gallery, quote/contact flows). Reused as-is; changed only when a dashboard, auth, or content need requires it.
- **V3 admin dashboard** — new, staff-only. Manages leads, clients, proposals/ROS, bookings, payment plans, documents, visa cases, and support.
- **V3 client portal** — new, client-only. Mirrors an online-store account area: journey, bookings, payments/receipts, documents, visa center, regional tours, support, profile, settings.

All three share one authentication and permission model but are otherwise separate concerns (see `.claude/rules/architecture.md`).

## 4. Core Engineering Principles

- Build the smallest complete vertical slice for the task at hand; do not scaffold ahead of an approved phase.
- Prefer clarity over cleverness; this platform will be maintained by a small team over years.
- Treat business rules (role boundaries, balance calculations, status lifecycles) as defined in the blueprint — do not reinterpret them.
- Never guess at an unconfirmed architecture or product decision; flag it as an open decision instead.

## 5. Phase-Gated Development Workflow

Work proceeds phase by phase per `docs/HERITAGE_V3_TASK_BOARD.md`. Before starting work:

- Confirm which phase is active and that the task falls inside its scope.
- Do not begin next-phase work while the active phase's completion gate is unmet, unless the user explicitly approves an exception.

Use the `phase-checkpoint` skill (`.claude/skills/phase-checkpoint/SKILL.md`) to evaluate whether a phase is ready to close. Only the user can approve marking a phase complete.

## 6. Required Validation Before Declaring a Task Complete

- Run whatever formatting, linting, type-checking, tests, and build steps exist for the files touched — never claim a check passed without actually running it.
- If no such tooling exists yet (current state), say so explicitly instead of claiming validation occurred.
- For UI changes, verify the behavior in a running instance once the app exists; do not rely on types/tests alone.
- Review the final diff for unrelated changes before reporting work as done.

See `.claude/rules/validation-deployment.md` for the full standard.

## 7. Security and Privacy Expectations

- Enforce authentication and role-based, assignment-based authorization on every dashboard and portal surface (see `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md`, Section 4).
- Clients must never be able to see another client's data.
- Treat personal data, documents, and payment records as sensitive by default; apply least-privilege access.
- Never commit secrets, credentials, or production configuration values.

See `.claude/rules/database-security.md` and `.claude/rules/admin-dashboard.md` / `.claude/rules/client-portal.md`.

## 8. Financial Data Accuracy Expectations

- Monetary values are never stored or computed using binary floating-point arithmetic.
- Balance calculations follow the blueprint exactly: confirmed amount paid = sum of confirmed payments only; remaining balance = booking total − confirmed amount paid. Pending, rejected, cancelled, failed, refunded, and reversed payments must never reduce the balance.
- All balance and payment-status logic is computed and validated server-side.

## 9. Tourism Content Accuracy

- Do not fabricate tour details, pricing, destinations, or availability. Tourism content must reflect real, approved source material (V2 content or explicit staff-provided content).
- Do not introduce placeholder content that could be mistaken for real production data.

## 10. Focused Rules

Detailed, area-specific rules live under `.claude/rules/`:

- `architecture.md` — application boundaries and module organization.
- `frontend.md` — public site, admin, and client portal UI standards.
- `backend.md` — API and service-layer standards.
- `admin-dashboard.md` — admin-specific access and workflow rules.
- `client-portal.md` — client-specific access and workflow rules.
- `database-security.md` — data modeling and security standards.
- `validation-deployment.md` — validation, environments, and release process.

Consult the relevant file before working in that area; do not duplicate its content here.

## 11. Reusable Skills

Use the workflows under `.claude/skills/` for recurring work:

- `feature-implementation` — implementing a scoped feature end to end.
- `code-review` — reviewing a diff for correctness, security, and quality.
- `phase-checkpoint` — evaluating whether an active phase is ready to close.
- `goal` — planning and, only when explicitly requested and in scope, executing a stated goal under phase-gate and validation discipline. Invoked by the user as `/goal [goal description]`; it is not auto-invoked.

## 12. Scope Discipline

- Do not perform unrelated refactors, renames, or cleanups while completing a requested task.
- Do not expand a task's scope beyond what was asked or what the active phase requires without checking with the user first.

## 13. Git Safety

- Never run `git commit`, `git push`, `git reset`, `git rebase`, or other destructive/history-altering commands unless the user explicitly asks for that specific action in that turn.
- Prior approval of one git action is not blanket approval for future ones.

## 14. Project Subagent: v3-reviewer

`.claude/agents/v3-reviewer.md` defines a strictly read-only review subagent for Heritage Philippines V3 changes. It has only the Read, Grep, and Glob tools: it cannot edit, write, delete, or move files, and it cannot run shell or git commands. Use it to review diffs, changed files, or planning documents for security, privacy, authorization, financial accuracy, data-loss risk, scope, and blueprint/phase compliance. It returns an evidence-backed findings report only — applying any fix is a separate task under the normal rules above.
