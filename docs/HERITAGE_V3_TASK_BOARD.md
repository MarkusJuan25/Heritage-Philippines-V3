# Heritage Philippines V3 Task Board

## Document Status

- Project: Heritage Philippines V3
- Current phase: Phase 1 — Project Foundation (active; ADR proposed, implementation not started)
- Last updated: July 9, 2026
- Companion document: `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md`
- Management approval: Management approved the current V3 structure and workflow on July 9, 2026.
- Creative delegation: The team may refine visual design, UX, and implementation quality, subject to later stakeholder feedback, without overriding security, privacy, authorization, audit, accessibility, mobile-first, or financial-integrity requirements.

This board tracks phase-level progress for V3. It is not a full ticket/backlog system; it exists to keep phase scope, sequencing, and completion criteria visible in one place.

---

## Phase 0: Blueprint and Architecture — July 8–14, 2026 (COMPLETE)

### Completed

- [x] V3 repository initialized
- [x] Planning structure created
- [x] Initial project blueprint committed
- [x] Repository pushed to GitHub

### Completed Requirements

- [x] Define roles and permission boundaries (System Administrator, Admin / Manager, Travel Consultant, Finance / Accounting, Visa Documentation Staff, Client)
- [x] Document core domain concept separation (Lead, Client, User account, Portal invitation, Proposal/ROS, Booking, Payment plan, Visa case)
- [x] Define lead and inquiry lifecycle, statuses, duplicate detection, and spam controls
- [x] Define client portal invitation-based onboarding flow and statuses
- [x] Document the full client journey end-to-end
- [x] Define proposal / ROS versioning and acceptance workflow
- [x] Define Support & Messages structure, categories, and access rules
- [x] Complete Payments planning (balance formulas, statuses, responsibilities, receipts)
- [x] Define Documents planning (categories, lifecycle, security controls)
- [x] Refine database entity list (conceptual responsibilities only, no schema yet)
- [x] Confirm delivery targets and MVP scope boundaries
- [x] Record open naming/product decisions
- [x] Stakeholder review and sign-off of the updated blueprint

### Completion Gate

Phase 0 is complete when the project blueprint covers roles, domain concepts, lead lifecycle, onboarding, client journey, proposals, messaging, payments, documents, and database entities; all open decisions are explicitly logged; and the updated blueprint has been reviewed and approved by management before Phase 1 implementation begins.

**Status:** Satisfied on July 9, 2026. Management approved the current V3 structure and workflow, and all unresolved decisions remain explicitly logged in `docs/HERITAGE_V3_DECISIONS_LOG.md`. Phase 1 and later implementation tasks remain unchecked and may only proceed under their own phase gates.

---

## Phase 1: Project Foundation — July 15–26, 2026

Tasks: confirm technical stack via an ADR (blueprint Section 16.2), environment configuration, authentication foundation, database schema implementation from the Phase 0 entity plan, base role/permission enforcement, staff account/role/assignment management needed to operate the six roles (blueprint Section 15.5), CI basics, deployment pipeline skeleton.

### Checklist

- [x] Draft technology stack ADR (`docs/adr/ADR-001-technology-stack.md`) with status Proposed
- [x] Review and accept the technology stack ADR
- [x] Initialize package manager and workspace metadata after ADR acceptance
- [x] Scaffold the application folders after ADR acceptance
- [ ] Document local, staging, and production environment configuration
- [ ] Establish authentication/session foundation
- [ ] Implement database schema and reviewed migrations from the approved Phase 0 entity plan
- [ ] Implement base role, permission, assignment, and client-ownership enforcement
- [ ] Implement staff account, role, and assignment management needed to operate the six approved roles
- [ ] Establish CI basics using real repository commands once tooling exists
- [ ] Create deployment pipeline skeleton for staging and production

**Completion gate:** A staff member can log in with a role-restricted account against a real database, and the implemented schema matches the approved Phase 0 entity plan.

## Phase 2: Admin Dashboard Core — July 27–August 16, 2026

Tasks: dashboard overview, lead and inquiry management (with statuses, duplicate detection, and spam controls), client management, staff assignment, proposal / ROS authoring and versioning, recording externally received proposal responses per blueprint Section 9.1 (Accept, Decline, or Request Changes captured before the client portal exists in Phase 3, with response method, acting staff member, timestamp, and supporting evidence reference), booking management, activity logging.

**Completion gate:** Staff can manage the full lead → client → proposal → booking flow end-to-end in a staging environment with role boundaries enforced, using the Section 9.1 externally-recorded-response fallback for proposal acceptance since the client portal is not yet built (Phase 3).

## Phase 3: Client Dashboard Core — August 17–September 6, 2026

Tasks: portal invitation flow, account activation, client dashboard (overview, my journey, bookings), proposal review with Accept / Decline / Request Changes, read-only Regional Tours view reusing or linking the V2 public catalogue (blueprint Section 15.5), client-visible communication foundation.

**Completion gate:** An invited client can activate an account, view their proposal, and respond with Accept, Decline, or Request Changes end-to-end in staging.

## Phase 4: Payments, Documents, Visa, and Support — September 7–20, 2026

Tasks: payment plans, installments, payment confirmation / reversal / refund / adjustment, receipts, reminders, basic finance exports (blueprint Section 15.5); document upload, review, and approval with secure download links; visa case management; Support & Messages (conversations, categories, attachments, email notifications).

**Completion gate:** A full booking can move through deposit → installments → documents → conditional visa case → completed payment with correct balance calculations and audit history.

## Phase 5: MVP Integration and Staging — September 21–30, 2026

Tasks: end-to-end integration testing, notifications, cross-module QA, staging deployment, internal user acceptance testing with staff, bug triage.

**Completion gate:** Internal MVP is deployed to staging and usable by staff and selected clients per the MVP scope defined in the blueprint (target date: September 30, 2026).

## Phase 6: Security and Production Hardening — October 1–18, 2026

Tasks: security review, access-control audit, malware scanning verification, expiring-download-link audit, performance tuning, backup/restore verification, production environment configuration.

**Completion gate:** Security review findings are resolved or explicitly accepted by management; production environment is configured and verified.

## Phase 7: User Acceptance Testing and Launch — October 19–31, 2026

Tasks: user acceptance testing with stakeholders and selected clients, final bug fixes, launch readiness checklist, go-live.

**Completion gate:** User acceptance testing sign-off is obtained, a rollback plan is confirmed in advance, and production launch is executed (target date: October 31, 2026).

---

## Scope-Control Rules

- No phase begins implementation work until its predecessor's completion gate is met, unless management explicitly approves a scoped exception.
- New feature requests raised during an active phase are logged in the Post-Launch Backlog (or a future phase) rather than expanding the active phase's scope, unless they block that phase's completion gate.
- Items explicitly placed outside the MVP (blueprint Sections 15.4 and 15.5) — full Gmail synchronization, full inbound email ingestion, Facebook Messenger, WhatsApp, AI automation, advanced business intelligence, full tours/website content management, a full System Settings UI, and nonessential animations or cosmetic enhancements — must not be pulled into any phase without an explicit, documented scope-change decision.
- Any change to role boundaries, balance-calculation rules, or record-separation rules (blueprint Sections 4, 5, and 11) requires updating the blueprint before implementation changes are made.

## Definition of Done

A task or phase is done when:

- The functionality matches its blueprint definition, with no undocumented behavior.
- Role and permission boundaries are enforced and verified.
- Balance, status, and lifecycle rules produce correct results for normal and edge cases (pending/failed/reversed payments, duplicate leads, expired invitations, and similar cases).
- Audit logging captures the relevant actions.
- The relevant planning document is updated if implementation revealed a needed clarification.
- Changes are reviewed before merging to `main`.

## Post-Launch Backlog

Items intentionally deferred beyond the October 31, 2026 launch:

- Full Gmail inbox synchronization
- Full inbound email reply ingestion
- Facebook Messenger integration
- WhatsApp integration
- Omnichannel / unified-inbox communication
- AI automation features
- Advanced business intelligence / analytics
- Nonessential animations and cosmetic enhancements
- Public self-service portal signup, if approved later, beyond invitation-only onboarding
- A dedicated Content Manager role, if content workload later justifies it
- Full Tours and Packages content management (unless separately approved earlier)
- General website content management (unless separately approved earlier)
- Full System Settings user interface

---

This document should be updated as phases progress. Do not create a duplicate task board file — update this one.
