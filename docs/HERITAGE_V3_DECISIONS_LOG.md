# Heritage Philippines V3 — Decisions Log

Records project decisions and their status. Statuses used:

- **Open** — recognized as needing a decision; no concrete proposal yet.
- **Proposed** — a concrete proposal exists and is awaiting explicit stakeholder/management approval.
- **Approved / Rejected / Superseded** — reserved for outcomes explicitly confirmed by management; no entry may be marked Approved without recorded approval evidence.

Entries D-001 through D-009 were recorded on July 9, 2026 from the Phase 0 stakeholder-review remediation of `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md`. Entries marked Approved carry explicit management approval evidence in this log.

---

## D-001 — Technology stack

- **Status:** Accepted
- **Date approved:** July 9, 2026
- **Decision:** `docs/adr/ADR-001-technology-stack.md` is the authoritative technology-stack decision for Heritage Philippines V3: a TypeScript / Node.js active-LTS / Next.js modular monolith with pnpm, resource-oriented JSON API routes, shared Zod validation contracts, PostgreSQL, Prisma, reviewed migrations, private object storage, outbound email notifications, GitHub Actions CI, and separate staging/production environments, deployed to a VPS-class (or equivalent) environment supporting persistent Node.js processes, background work, secure environment-variable configuration, health checks, and controlled deployments.
- **Constraint:** This preserves Hostinger's VPS tier (or an equivalent VPS/managed-Node host) as a realistic deployment target without selecting a final hosting vendor; final hosting-provider, database-provider, storage-provider, and email-provider selection remain deferred (ADR-001 "Items Intentionally Deferred"). Acceptance of the stack does not itself authorize any implementation step ahead of its own Phase 1 gate in `docs/HERITAGE_V3_TASK_BOARD.md`.
- **Effect:** Closes the ADR-001 review/acceptance gate. Phase 1 implementation tasks that were waiting on ADR acceptance (package manager initialization, application-folder scaffolding, and subsequent Phase 1 work) may now proceed under their own Task Board checklist and completion gate; this entry does not itself mark any Phase 1 task complete or advance the project beyond Phase 1.

## D-002 — Currency strategy

- **Status:** Proposed — pending explicit stakeholder approval
- **Proposal:** The Philippine peso (PHP) is the single billing currency for the MVP; the Booking currency field (blueprint Section 13.4) is fixed to it; multi-currency support is deferred.
- **Blocks:** Phase 4 payment work; affects Phase 1 schema design (money column types and the currency field).

## D-003 — Retention periods for documents, activity logs, audit logs, and other personal data

- **Status:** Open — pending privacy/compliance review (D-004)
- **Decision needed:** Retention and eventual deletion durations. No final durations are set; none should be invented ahead of the compliance review.
- **Blocks:** Phase 6 (production hardening); related to the existing lead-retention open decision (blueprint Sections 6.5 and 16.2).

## D-004 — Philippine privacy/compliance posture

- **Status:** Open — requires stakeholder/legal review
- **Decision needed:** Applicability of the Data Privacy Act of 2012 and related obligations, consent requirements, breach-response planning, and the retention policy (D-003).
- **Blocks:** Must be resolved before Phase 6 sign-off.

## D-005 — MVP module scope classification

- **Status:** Approved — management approved as part of the Phase 0 structure and workflow baseline on July 9, 2026 (D-010)
- **Proposal:** The classification in blueprint Section 15.5 — staff/role/assignment management as Phase 1 foundation; dashboard overview in Phase 2; Regional Tours as a Phase 3 read-only reuse of the V2 catalogue; basic finance exports in Phase 4; tours/website content management deferred unless separately approved; advanced reports/BI, full System Settings UI, and cosmetic customization post-MVP.

## D-006 — Canonical conversion → proposal → acceptance lifecycle

- **Status:** Approved — management approved as part of the Phase 0 structure and workflow baseline on July 9, 2026 (D-010)
- **Proposal:** Lead is qualified; staff explicitly converts/links the Lead to a Client; the Proposal / ROS is prepared for the Client; the portal invitation is sent; the client activates the account, reviews the current version in the portal, and responds Accept / Decline / Request Changes; a Booking is created from the accepted version by an explicit staff action (blueprint Sections 5–9). Externally received responses are recorded under the controlled fallback in blueprint Section 9.1, attributed to the recording staff member.

## D-007 — Refund and reversal semantics

- **Status:** Approved — management approved as part of the Phase 0 structure and workflow baseline on July 9, 2026 (D-010)
- **Proposal:** Only currently confirmed, non-reversed, non-refunded payments count toward the confirmed amount paid. A reversal corrects or voids an erroneous confirmation; a refund is money returned after a valid confirmed payment, and normally increases the remaining balance by the refunded amount, with any exception handled through a separate approved adjustment. Refunds are Finance-only with full audit values; receipts and payment history are never deleted (blueprint Sections 11.1, 11.2, 11.5, 11.7).

## D-008 — Refund documentation type

- **Status:** Open
- **Decision needed:** Whether a refund produces a refund reference, credit note, or equivalent record (blueprint Section 11.5).
- **Blocks:** Phase 4 implementation detail; does not block earlier phases.

## D-009 — Role-boundary clarifications

- **Status:** Approved — management approved as part of the Phase 0 structure and workflow baseline on July 9, 2026 (D-010)
- **Proposal:** (a) Finance / Accounting visibility is assignment-based (financial records for bookings assigned to Finance), with Admin / Manager able to grant broader operational scope, and no automatic access to unrelated documents or visa information (blueprint Section 4.4). (b) Admin / Manager and the assigned Travel Consultant prepare, send, resend, and revoke portal invitations, with resend/revoke audited (Section 7.3). (c) System Administrator access is platform/security administration and does not automatically grant unrestricted operational-client access (Section 4.1). (d) Authorized staff may create leads manually for offline inquiries, with source tracking and duplicate checks (Section 6.8).

## D-010 — Phase 0 management approval and creative delegation

- **Status:** Approved
- **Date approved:** July 9, 2026
- **Decision:** Management approved the current Heritage Philippines V3 structure and workflow as the Phase 0 planning baseline. The team has delegated creative freedom to refine visual design, UX, and implementation quality, subject to later stakeholder feedback when management sees something it wants adjusted.
- **Constraint:** Creative freedom does not override security, privacy, authorization, audit, accessibility, mobile-first, or financial-integrity requirements. Open technical, retention, privacy/compliance, currency, lead-assignment, status-list, and refund-documentation decisions remain governed by their own entries until explicitly resolved.
- **Effect:** Closes the Phase 0 stakeholder review and sign-off gate in `docs/HERITAGE_V3_TASK_BOARD.md`; does not mark Phase 1 or later implementation tasks complete.

## D-011 — Authentication library selection

- **Status:** Accepted
- **Date accepted:** July 10, 2026
- **Decision:** Better Auth, with its official Prisma/PostgreSQL adapter (`better-auth/adapters/prisma`), is the authentication and session library for Heritage Philippines V3. This fulfills ADR-001's deferred "Select a vetted authentication/security library after checking its official documentation" follow-up action (ADR-001, "Immediate, pre-Phase-1-scaffolding").
- **Rationale:** Evaluated against Lucia and Auth.js (NextAuth). Lucia was deprecated by its maintainer in March 2025 and is no longer distributed as an installable library (repositioned as an educational resource) — disqualified as "maintained." Auth.js's Credentials provider is architecturally hardcoded to JWT-only sessions and cannot use real database-backed sessions without unsupported workarounds, conflicting with ADR-001's stated preference for "database-backed session state" and this project's rule against inventing custom session mechanics. Better Auth supports credentials-based login and database-backed sessions natively through its official Prisma adapter, hashes passwords internally (scrypt) rather than requiring custom cryptography, and supports disabling public self-service sign-up (`emailAndPassword.disableSignUp`) while keeping sign-in enabled — required to satisfy blueprint Section 7's invitation-only-signup rule. As of September 2025 the Auth.js/NextAuth maintainers themselves joined the Better Auth project and now recommend it for new projects. It requires no serverless-specific hosting platform, remaining compatible with Hostinger-managed VPS-class Node.js hosting (ADR-001).
- **Constraint:** This selects a library within ADR-001's already-approved architecture (Next.js, Prisma, PostgreSQL, cookie-based sessions) and does not alter the accepted technology stack. It does not implement custom cryptography, password hashing, or session-token primitives, consistent with ADR-001's security requirements.
- **Effect:** Implements the technology choice underlying the Phase 1 "Establish authentication/session foundation" checklist item in `docs/HERITAGE_V3_TASK_BOARD.md`. Final MFA/SSO and any additional auth providers remain open per blueprint Section 16.2.

---

Update this log when a decision's status changes; do not delete entries — supersede them.
