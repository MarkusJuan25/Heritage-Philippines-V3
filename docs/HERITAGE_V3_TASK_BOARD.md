# Heritage Philippines V3 Task Board

## Document Status

- Project: Heritage Philippines V3
- Current phase: Phase 1 — Project Foundation (active; ADR accepted, workspace/tooling scaffold, environment-configuration documentation, and CI quality-gate workflow complete. The authentication/session foundation (Better Auth + Prisma-backed sessions, role guards, login/logout) is implemented and unit/smoke-tested, and real sign-in has since been verified against the disposable local `heritage_v3_test` database via `apps/web/src/features/staff/service.integration.test.ts`. Staff account, role, and deactivation/reactivation management (`/api/staff/*`) is implemented and tested. Lead, Client, and Booking staff-assignment management (`/api/leads/[id]/assignment`, `/api/clients/[id]/assignment`, `/api/bookings/[id]/assignment`) is also implemented and tested — set/replace for all three targets, plus end-without-replacement for Lead and Client (Booking assignment intentionally remains set/replace-only per `docs/HERITAGE_V3_DECISIONS_LOG.md` D-015). With this, the Phase 1 "Implement staff account, role, and assignment management needed to operate the six approved roles" checklist item is complete. The Prisma/PostgreSQL schema and migrations now also cover Lead, LeadStatusHistory, Client, StaffAssignment (migration `20260714024613_lead_client_assignment_foundation`), ClientProfile/PortalInvitation (migration `20260715014939_client_portal_ownership_foundation`), Proposal/ProposalVersion/ProposalAcceptance (migration `20260715055859_proposal_ros_foundation`), and Booking/BookingStatusHistory with StaffAssignment extended to support Booking as an assignment target (migration `20260716020734_booking_schema_foundation`) — still not the full Phase 0 entity plan (Payment, Document, VisaCase, and related entities remain unimplemented). The Booking Schema Foundation schema-and-migration checkpoint is complete: migration `20260716020734_booking_schema_foundation` was successfully applied via `prisma migrate dev` to the local `heritage_v3_dev` database on July 16, 2026, and `prisma migrate status` subsequently found all 6 migrations with the database schema reported up to date. Explicit Booking creation (`POST /api/bookings`, from an accepted ProposalVersion), a staff-only paginated Booking list, and staff-only single-Booking retrieval (`GET /api/bookings`, `GET /api/bookings/[id]`) are now implemented and tested (`apps/web/src/features/bookings/`), scoped to ADMIN_MANAGER (unconditional) and TRAVEL_CONSULTANT (only for Clients they are actively assigned to, scoped in the database query itself); every rejected role (CLIENT, FINANCE_ACCOUNTING, VISA_DOCUMENTATION, SYSTEM_ADMINISTRATOR) is refused, and no client-portal Booking access exists. Each creation writes the Booking, an initial DRAFT `BookingStatusHistory` row, and one `BOOKING_CREATED` `AuditLog` entry atomically, is idempotent per ProposalVersion, and generates `bookingReference` server-side per `docs/HERITAGE_V3_DECISIONS_LOG.md` D-013. Booking detail update, client-portal Booking access, and Booking UI all remain unimplemented and deferred to later checkpoints. Booking status-transition enforcement (`PUT /api/bookings/[id]/status`) is now implemented and tested per the confirmed transition matrix, authorization rules, and concurrency behavior recorded in `docs/HERITAGE_V3_DECISIONS_LOG.md` D-014: ADMIN_MANAGER (unconditional) and TRAVEL_CONSULTANT (only via the existing active-Client-assignment check) may transition a Booking's status through the fixed matrix, with a caller-supplied `expectedStatus` optimistic-concurrency check (a stale value returns `BOOKING_CONFLICT`), a same-status request treated as an idempotent no-op (no new history row, no audit entry), and every actual transition writing the Booking update, a `BookingStatusHistory` row, and a `BOOKING_STATUS_CHANGED` `AuditLog` entry atomically in one transaction. No `reason` field, Booking-specific `StaffAssignment` enforcement, or Document/VisaCase-driven status model is part of this checkpoint. This booking-workflow-enforcement work implements part of Phase 2's "booking management" task ahead of Phase 1's own checklist fully closing (Payment/Document/VisaCase/Conversation schema and the staff-management checklist item remain open) — proceeded under this session's explicit, scoped direction rather than a formal phase-gate exception sign-off. A first slice of assignment-based enforcement now exists: `/api/leads/[id]/assignment` and `/api/clients/[id]/assignment` let an Admin / Manager set, replace, or end a Lead's or Client's Travel Consultant assignment (Admin / Manager only — System Administrator has no implicit operational permission here), with server-side assignee-eligibility validation, atomic reassignment, and audit logging. `PUT /api/bookings/[id]/assignment` extends this same shared `features/assignments` implementation (`TargetKind` now also covers `'BOOKING'`) to let an Admin / Manager set or replace a Booking's Travel Consultant assignment, independently of any Client-level assignment on the Booking's Client (per `docs/HERITAGE_V3_DECISIONS_LOG.md` D-015) — no cascade in either direction, and no `DELETE`/removal-without-replacement endpoint in this checkpoint. Booking read, list, and status-transition authorization (D-014) are unchanged by this and continue to use Client-level assignment only. The reusable `canAccessLead`/`canAccessClient` resource-authorization foundation now also enforces client-portal ownership: an authenticated CLIENT user is authorized for a Client record only when their User id is linked to that exact Client id through ClientProfile (blueprint Sections 4.6, 14.1), resolved by a database query scoped on both fields. No Lead/Client CRUD, proposal-management, payment, document, or visa functionality exists yet, and no client-facing route exists yet either, so `canAccessLead`/`canAccessClient` — both its staff-assignment and its client-ownership halves — remain unwired to any Lead/Client resource route. The Booking routes (`/api/bookings`, `/api/bookings/[id]`) do not use this shared guard; they enforce authorization through their own actor-scoped repository queries (`apps/web/src/features/bookings/repository.ts`). Portal invitation preparation, sending, resending, opening, revoking, expiration processing, account activation, raw token generation/hashing, email delivery, account-creation code, client-facing API routes, and client portal UI all remain unimplemented. See `docs/HERITAGE_V3_DECISIONS_LOG.md` D-011, D-012. The Conversation Schema Foundation schema-only checkpoint adds `ConversationCategory`, `MessageVisibility`, `ConversationParticipantRole`, `Conversation`, `ConversationParticipant`, `Message`, and `MessageAttachment` (blueprint Sections 10, 14.3; `docs/HERITAGE_V3_DECISIONS_LOG.md` D-016) — a per-participant `ConversationParticipant.lastReadAt` read-state model rather than a shared `Message`-level boolean, exclusive staff/client identity paths on both `ConversationParticipant` and `Message`, removable-with-history participant membership, at most one currently modeled related record (Booking or Proposal, never both — VisaCase deferred until that entity exists), and a database restriction preventing a client-authored message from being an internal note. This checkpoint's schema is split across two migrations because of a documented implementation-session incident (D-016): `20260717010445_conversation_schema_foundation` (tables, enums, standard indexes, foreign keys) was applied to the local `heritage_v3_dev` database ahead of schedule, before its hand-written constraints existed, and was left byte-for-byte unchanged rather than edited post-application; `20260717010520_conversation_schema_constraints` (every hand-written PostgreSQL CHECK constraint and partial unique index this checkpoint requires) was created, reviewed, and then also applied. **Both Conversation migrations were successfully applied to local `heritage_v3_dev` on July 17, 2026**, and `prisma migrate status` subsequently reported all 8 migrations applied and the database schema up to date; a read-only catalog check confirmed all four hand-written CHECK constraints and both partial unique indexes are present and valid. Application to staging and production has not occurred as part of this checkpoint and must be verified independently before either environment is considered current. Conversation/message repository layer, service layer, API routes, admin dashboard and client portal UI, conversation/message authorization (Admin/Manager full visibility, client ownership and participation, Travel Consultant active assignment, explicit Finance/Visa Documentation participation, server-side internal-note exclusion), email notification delivery, attachment malware scanning/signed-URL issuance, and tests/seed data all remain unimplemented and deferred to future checkpoints. The Visa Case Schema Foundation checkpoint is complete: `docs/HERITAGE_V3_DECISIONS_LOG.md` D-017 is accepted, and migration `20260717024618_visa_case_schema_foundation` — generated, reviewed, and hand-augmented with its required PostgreSQL constraints per D-017 — was successfully applied to the local `heritage_v3_dev` database on July 17, 2026 via `prisma migrate deploy`; `prisma migrate status` subsequently reported all 9 migrations applied and the schema up to date, and a read-only PostgreSQL catalog check confirmed every expected table, column, index, foreign key, and hand-written constraint. The completed schema adds one optional `VisaCase` per Booking (`bookingId @unique`), the nine-value `VisaCaseStatus` enum (`OPENED`, `REQUIREMENTS_PENDING`, `UNDER_REVIEW`, `ADDITIONAL_INFORMATION_REQUIRED`, `READY_FOR_SUBMISSION`, `SUBMITTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`), `VisaStatusHistory`, direct `Client` and `Booking` relations on `VisaCase`, `VisaCase` as a schema-level `StaffAssignment` target, and `VisaCase` as an optional `Conversation` related-record target — backed by the widened four-target `staff_assignment_lead_xor_client_xor_booking_xor_visa_case` XOR CHECK, the `staff_assignment_active_visa_case_key` partial unique index, the widened three-target `conversation_related_record_exclusive` CHECK, and the `visa_status_history_status_changed` CHECK. `VisaRequirement` and all Document entities remain unmodeled; VisaCase repository/service layers, `features/assignments` `TargetKind` wiring, VisaCase authorization, status-transition enforcement, API routes, admin dashboard and client portal UI, and notifications all remain unimplemented and deferred to future checkpoints. This migration has not been applied to staging or production, and CI has not yet re-verified this branch. The Document Schema Foundation checkpoint's Stage A schema and `docs/HERITAGE_V3_DECISIONS_LOG.md` D-018 are accepted, and migration `20260717073151_document_schema_foundation` — generated and hand-augmented with its six required PostgreSQL CHECK constraints (`document_requirement_target_exclusive`, `document_context_exclusive`, `document_uploader_path_exclusive`, `document_version_positive`, `document_previous_not_self`, `document_review_reason_required`) — is confirmed applied to the local `heritage_v3_dev` database: a `prisma migrate status` check on July 20, 2026 reported 10 migrations found and the database schema up to date. Application to staging or production remains unverified and is not claimed. Document repositories, services, APIs, authorization, upload/download flows, malware scanning, signed/expiring download URLs, admin dashboard and client portal UI, tests, and seed data all remain deferred to future checkpoints. The Payment Schema Foundation checkpoint is now complete: migration `20260720060555_payment_schema_foundation` — generated, reviewed, and hand-augmented with 16 CHECK constraints, the widened `document_context_exclusive` replacement, and the `installment_active_deposit_key` partial unique index — was applied to the local `heritage_v3_dev` database on July 20, 2026; `prisma migrate status` subsequently reported all 11 migrations applied and the schema up to date, and a read-only PostgreSQL catalog check confirmed every expected table, constraint, index, and foreign key. The implemented schema adds `PaymentPlan`, `Installment`, `Payment`, `PaymentStatusHistory`, `PaymentAllocation`, `PaymentAllocationReversal`, `PaymentRefund`, `PaymentRefundAllocation`, and `Receipt`; `Booking.totalAmount`/`currencyCode`; and `Document.paymentId` for payment-proof evidence. Payment was the final previously documented Payment-specific blocker for this checklist item, and its schema migration is now complete — the Notification Schema Foundation checkpoint is now also complete: `docs/HERITAGE_V3_DECISIONS_LOG.md` D-020 is accepted, and migration `20260721021220_notification_schema_foundation` — reviewed, requiring no hand-written PostgreSQL constraint per D-020 — was successfully applied to the local `heritage_v3_dev` database on July 21, 2026; `prisma migrate status` subsequently reported all 12 migrations applied and the database schema up to date, and Prisma schema validation passed. The implemented schema adds `Notification` — a durable in-app alert with a required `recipientUserId` → `User` relation (`onDelete: Restrict`), a free-form `eventKey`, `title`/`message` display content, an optional internal-relative `actionPath`, and a nullable `readAt` — and `User.notificationsReceived`. Notification was the final unresolved entity-plan blocker D-019's own implementation-status update identified; with its migration now verified applied, the overall Phase 1 "Implement database schema and reviewed migrations from the approved Phase 0 entity plan" checklist item is complete within its approved Phase 0 entity-plan and documented checkpoint boundary. This does not claim every blueprint Section 14 entity is implemented: `Permission` (D-012), `VisaRequirement` (D-017/D-018), `ActivityLog`'s access/download-logging purpose (D-018), `TourPackage`/`ItineraryVersion` (the Booking Schema Foundation checkpoint), and `PaymentAdjustment` (D-019) each remain governed by their own documented deferral, unaffected by this checklist item's completion. Notification repositories, services, event-production rules, API routes, admin dashboard and client portal UI, recipient authorization enforcement, mark-read behavior, email delivery, background jobs, and tests/seed data all remain deferred to later implementation phases per D-020, most falling under Phase 5. Schema completion for Payment specifically does not mean Payment APIs, business workflows, downloadable Excel/PDF reports, client-facing balance/receipt summaries, or receipt delivery are implemented; all remain deferred to later phases per `docs/HERITAGE_V3_DECISIONS_LOG.md` D-019. Application to staging or production is not claimed and must be verified independently.)
- Last updated: July 21, 2026
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
- [x] Document local, staging, and production environment configuration
- [x] Establish authentication/session foundation — implemented (Better Auth + Prisma-backed sessions, role guards, login/logout); real PostgreSQL sign-in verified against the disposable local `heritage_v3_test` database through `apps/web/src/features/staff/service.integration.test.ts`, see note below
- [x] Implement database schema and reviewed migrations from the approved Phase 0 entity plan
- [x] Implement base role, permission, assignment, and client-ownership enforcement
- [x] Implement staff account, role, and assignment management needed to operate the six approved roles
- [x] Establish CI basics using real repository commands once tooling exists
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
