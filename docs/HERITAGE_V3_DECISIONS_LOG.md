# Heritage Philippines V3 — Decisions Log

Records project decisions and their status. Statuses used:

- **Open** — recognized as needing a decision; no concrete proposal yet.
- **Proposed** — a concrete proposal exists and is awaiting explicit stakeholder/management approval.
- **Approved / Rejected / Superseded** — reserved for outcomes explicitly confirmed by management; no entry may be marked Approved without recorded approval evidence.

Entries D-001 through D-009 were recorded on July 9, 2026 from the Phase 0 stakeholder-review remediation of `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md`. Entries marked Approved carry explicit management approval evidence in this log.

---

## D-001 — Technology stack

- **Status:** Open
- **Decision needed:** Framework, language, database engine, and ORM for V3. No stack has been selected; any prior mention of specific technologies is a candidate only.
- **Constraint:** Must be decided through an Architecture Decision Record (ADR) before any application scaffolding begins (`.claude/rules/architecture.md`; blueprint Section 16.2).
- **Blocks:** Phase 1 start.

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

---

Update this log when a decision's status changes; do not delete entries — supersede them.
