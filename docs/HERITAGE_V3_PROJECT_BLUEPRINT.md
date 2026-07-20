# Heritage Philippines V3 Project Blueprint

## Document Status

- Project: Heritage Philippines V3
- Status: Phase 0 complete — management-approved structure and workflow baseline
- Repository: Heritage-Philippines-V3
- Primary branch: `main`
- Foundation: Heritage Philippines V2
- Last updated: July 9, 2026
- Revision notes: Documents the project's planning position for roles, domain model, lead lifecycle, portal onboarding, client journey, proposal/ROS, messaging, payments, documents, database, and delivery targets, as drafted through July 8, 2026. On July 9, 2026, this document received a Phase 0 stakeholder-review remediation pass (expanded open-decision register, Client/TourPackage entities, reconciled conversion/acceptance lifecycle, refund/reversal semantics, module scope classification, role clarifications). Management approved the current V3 structure and workflow on July 9, 2026, closing the Phase 0 stakeholder review and sign-off gate; remaining open decisions stay tracked in `docs/HERITAGE_V3_DECISIONS_LOG.md`.
- Management approval: The current Heritage Philippines V3 structure and workflow are approved as the Phase 0 planning baseline.
- Creative delegation: The team has delegated creative freedom to refine visual design, UX, and implementation quality, subject to later stakeholder feedback. This freedom does not override security, privacy, authorization, audit, accessibility, mobile-first, or financial-integrity requirements.

---

## 1. Project Vision

Heritage Philippines V3 will extend the stable Heritage Philippines V2 public website into a complete tourism operations platform.

V3 will preserve the successful public-facing experience from V2 while introducing two protected application areas:

1. An internal administration dashboard for Heritage Philippines staff.
2. A client dashboard and portal styled like a modern online-store account area.

The platform should support the complete client journey, beginning with an inquiry or quotation and continuing through booking, installment payments, document submission, travel preparation, support, and tour completion.

The objective is not merely to add a dashboard. V3 should become a secure and maintainable operational system that connects clients, bookings, payments, documents, visa assistance, tours, and internal staff workflows.

---

## 2. Core Product Areas

Heritage Philippines V3 will contain three major product areas.

### 2.1 Public Website

The public website will continue using Heritage Philippines V2 as its stable foundation.

It will retain the existing public experience, including:

- Homepage
- About page
- Contact page
- Stories
- Gallery
- Tour catalogue
- Tour detail pages
- Package planner
- My Journey
- Quote request flow
- Contact inquiry flow
- Responsive mobile and desktop layouts
- Existing SEO structure
- Existing production-tested frontend behavior

V3 should avoid unnecessary rewrites of working V2 functionality.

Public-site changes should be made only when required for dashboard integration, authentication, content management, or an approved design revision.

### 2.2 Admin Dashboard

The admin dashboard will be used by authorized Heritage Philippines employees to manage the platform and client operations.

Initial dashboard areas should include:

- Dashboard overview
- Clients
- Leads and inquiries
- Proposals and ROS
- Bookings
- Payment plans
- Payments and receipts
- Documents
- Visa processing
- Tours and packages
- Website content
- Support & Messages
- Notifications
- Reports
- Staff and permissions
- Activity logs
- System settings

Not every area listed above ships in the initial MVP. Section 15.5 classifies each named module as MVP (with its delivering phase) or deferred/post-MVP; that classification was approved by management at Phase 0 sign-off on July 9, 2026.

### 2.3 Client Dashboard

The client dashboard will resemble a polished online-store account portal while remaining appropriate for travel services.

The client portal should include left-side navigation for:

- Home / Overview
- My Journey
- Bookings
- Payments & Receipts
- Documents
- Visa Center
- Regional Tours
- Support & Messages
- Profile
- Settings

These labels are the canonical portal navigation names; other documents must use them verbatim.

Two clarifications:

- **Regional Tours** is a read-only view of (or link to) the existing V2 public tour catalogue (Section 15.5) — it is not a new protected business-data module.
- The portal's **My Journey** area is the authenticated view of the client's actual journey progress (Section 8). It is distinct from the public V2 "My Journey" planner feature (Section 2.1), which remains unchanged, keeps its existing public URLs, and must not be broken or replaced by the portal area.

The portal should allow clients to view the current state of their travel arrangements without needing to request every update manually.

---

## 3. Primary Goals

Heritage Philippines V3 should:

1. Give management and staff a centralized view of clients and operations.
2. Give clients a transparent view of bookings, payments, documents, and travel progress.
3. Reduce manual tracking through messages, spreadsheets, and disconnected records.
4. Preserve the stable V2 public website.
5. Introduce role-based authentication and authorization.
6. Support installment payment schedules and remaining-balance calculations.
7. Maintain a complete history of important administrative actions.
8. Support future expansion without requiring another complete rebuild.
9. Remain usable on desktop, tablet, and mobile devices.
10. Protect client, payment, travel, identity, and document information.

---

## 4. Roles and Permission Boundaries

Heritage Philippines V3 uses an **assignment-based, least-privilege** permission model. A staff account is granted only the access its role requires, and — where applicable — only for the leads, clients, bookings, or visa cases explicitly assigned to that staff member. Access is never inherited from job title alone.

The platform defines six roles.

### 4.1 System Administrator

The System Administrator is a platform and security role, distinct from day-to-day operational management.

Capabilities:

- Create, modify, and deactivate platform user accounts
- Define roles and permissions, and assign roles to staff accounts
- Configure integrations (payment processors, email delivery, CAPTCHA/Turnstile, storage, etc.)
- Configure system-wide and security settings
- View audit logs and activity logs
- Grant the System Administrator role to another account (this role may only be granted by an existing System Administrator)

Explicit boundaries:

- System Administrator access exists for platform and security administration. It does not automatically grant unrestricted access to operational client data (leads, clients, proposals, bookings, payments, documents, or conversations); operational access follows the same role/assignment rules as any other staff account, and any administrative access to sensitive data is attributable and audited.

### 4.2 Admin / Manager

Admin / Manager holds full operational oversight of the business but is not a platform-security role.

Capabilities:

- Full visibility across leads, clients, proposals, bookings, payment plans, documents, and visa cases
- Manage staff accounts' operational role assignments and lead/client/booking assignments
- Prepare, send, resend, and revoke portal invitations (Section 7.3)
- Record externally received proposal responses under the controlled fallback in Section 9.1
- Oversee public website content
- View operational and financial reports

Explicit boundaries:

- Cannot modify audit logs (audit logs are system-generated and append-only for every role)
- Cannot grant themselves, or anyone else, System Administrator access

### 4.3 Travel Consultant

Travel Consultants manage the leads and clients assigned to them.

Capabilities:

- Manage assigned leads and clients
- Conduct consultations
- Prepare and revise proposals / ROS drafts and versions
- Prepare itineraries and booking preparation
- Communicate with assigned clients via Support & Messages
- Manage documents relevant to their assigned bookings (excluding visa-category documents)
- Prepare, send, resend, and revoke portal invitations for their assigned clients (Section 7.3)
- Record externally received proposal responses for their assigned clients under the controlled fallback in Section 9.1
- Propose commercial terms (deposit, installments, due dates) for a payment plan
- View payment progress for their assigned bookings (read-only)

Explicit boundaries:

- Cannot confirm, reverse, refund, or adjust payments
- Cannot issue official receipts

### 4.4 Finance / Accounting

Finance / Accounting manages the financial lifecycle of a booking.

Capabilities:

- Review and approve payment plans proposed by Travel Consultants
- Manage deposits, installments, and due dates
- Confirm, reverse, refund, and adjust payments
- Issue official receipts
- Track balances, overdue installments, and payment history
- Export financial reports

Visibility scope: Finance / Accounting accesses financial records (payment plans, payments, receipts, balances) for the bookings assigned to it, per the assignment-based model (Section 4.7). Admin / Manager may grant broader operational scope where the finance workload requires it. Finance access does not automatically extend to unrelated documents or visa information.

Explicit boundaries:

- Cannot edit itineraries
- Cannot edit proposal travel content
- Cannot make or edit visa decisions

### 4.5 Visa Documentation Staff

Visa Documentation Staff manage the conditional visa workflow for bookings that require it.

Capabilities:

- Manage visa cases, visa requirements, and visa document reviews
- Track visa deadlines and visa statuses
- Communicate with clients on visa-related matters via Support & Messages

Explicit boundaries:

- Cannot confirm, reverse, refund, or adjust payments
- Cannot edit bookings unrelated to their assigned visa cases

### 4.6 Client

Clients may only access records that belong to their own account.

Capabilities:

- View and manage their own profile and settings
- View their proposals/ROS and respond (Accept, Decline, or Request Changes)
- View their bookings, itineraries, and journey progress
- View their approved payment plans, payment history, balances, and receipts
- Upload, view, and track their own documents
- View their visa case progress
- Send and receive Support & Messages for their own records

### 4.7 Permission Model Notes

- Permissions are assignment-based: a Travel Consultant, Visa Documentation Staff member, or Finance user only sees records they are assigned to, plus any records an Admin / Manager explicitly grants visibility into.
- Section 14 (Database Entity Planning) defines the `User`, `Role`, `Permission`, `StaffProfile`, and `StaffAssignment` entities that implement this model.
- A dedicated Content Manager role is not part of the initial six roles; website content responsibilities are covered under Admin / Manager for now (see Section 16, Open Decisions).

---

## 5. Core Domain Concepts

To avoid ambiguity in later technical planning, V3 treats the following as **distinct concepts** that must not be automatically merged or auto-created from one another:

- **Lead** — An unqualified or in-progress inquiry from a prospective traveler. A Lead exists before any commercial or account relationship is established.
- **Client** — An individual or party who has progressed beyond the lead stage, typically through conversion, and has (or has had) an active commercial relationship with Heritage Philippines.
- **User account** — The authentication credential used to sign into the admin dashboard or client portal. A User account is an access mechanism, not a business record; both staff and clients have User accounts.
- **Portal invitation** — A time-limited, single-use mechanism used to grant a Client the ability to create and activate a User account tied to their Client record.
- **Proposal / ROS (Rundown of Service)** — A versioned travel plan and quotation prepared by a Travel Consultant for a Client (created or linked from a Lead through explicit staff conversion; Section 6.7).
- **Booking** — A confirmed commercial engagement created once a Proposal / ROS is accepted.
- **Payment plan** — The financial arrangement (deposit, installments, due dates) associated with a Booking.
- **Visa case** — A conditional workflow record created only when visa assistance is required for a Client's Booking or destination.

### 5.1 Non-Automatic Creation Rule

An inquiry must **not** automatically create a portal user, client account, booking, payment plan, or visa case. Each of these records is created deliberately, at the appropriate point in the journey, by an explicit staff or system action — never as a side effect of an inquiry being submitted.

### 5.2 Conceptual Relationship

```text
Lead --(qualification + explicit staff conversion)--> Client
Client --(consultant drafts)--> Proposal / ROS --(client Accept)--> accepted version
Accepted version --(explicit staff action)--> Booking
Booking --(Finance approval)--> Payment Plan
Booking --(conditional, only if required)--> Visa Case

Client --(portal invitation)--> Portal Invitation --(account activation)--> User Account (portal access)
```

A Lead can exist, be contacted, and be consulted without any of the later records existing. The Client record, Proposal, Booking, Payment plan, and Visa case each come into existence only through the explicit actions shown above — never as a side effect of an inquiry being submitted (Section 5.1). An accepted proposal does not itself create a Booking; the Booking is created from the accepted version by an explicit staff action.

The portal invitation / User account branch is a separate access-provisioning path, independent of the commercial chain above: a Client can be invited and activate portal access at any point, and — per Section 9.1 — a Proposal can be accepted, and a Booking created, even before the Client has portal access at all. Sections 7 and 8 describe the typical relative timing of invitation and activation within the canonical client journey; this diagram shows conceptual dependency, not a fixed calendar order.

---

## 6. Lead and Inquiry Lifecycle

### 6.1 Lead Statuses

| Status | Meaning |
| --- | --- |
| New | Inquiry received; not yet reviewed by staff. |
| Under Review | Staff is evaluating the inquiry's details and legitimacy. |
| Contacted | Initial outreach has been made to the prospective traveler. |
| Consultation Scheduled | A consultation call or meeting has been arranged. |
| Qualified | The lead has genuine, actionable travel intent. |
| Converted to Client | Staff has explicitly created or linked a Client record for this qualified lead (see 6.7). |
| Not Proceeding | The lead declined or is no longer interested before conversion. |
| Duplicate | Identified as a repeat submission of an existing lead or client. |
| Spam | Identified as a non-genuine or abusive submission. |
| Archived | Inactive lead retained per retention rules and excluded from active pipelines. |

Once a lead is Converted to Client, subsequent commercial progress — proposal preparation, delivery, and the client's decision — is tracked on the Client record and its Proposal / ROS (Section 9), not through further Lead statuses. Earlier drafts of this lifecycle carried proposal-stage statuses on the Lead itself; those stages now belong to the Proposal, consistent with the canonical journey in Section 8.

### 6.2 Duplicate Detection

Incoming inquiries are checked against existing leads and clients using normalized email address and phone number. Matches are flagged for staff review rather than silently merged, so a genuine new inquiry from a returning contact is never lost.

### 6.3 Spam and Abuse Controls

- Rate limiting on public inquiry endpoints, to limit repeated submissions within a time window.
- CAPTCHA or Cloudflare Turnstile on public-facing inquiry forms.
- Suspicious submissions are marked with the Spam status for staff review rather than silently discarded, preserving an audit trail.

### 6.4 Lead Assignment

Each lead is assigned to a Travel Consultant. Only the assigned consultant (plus Admin / Manager, per Section 4) has working access to that lead, consistent with the assignment-based permission model.

### 6.5 Archive and Retention

Leads that do not progress within a to-be-finalized period may be archived. Archived leads are retained for reporting and audit purposes but excluded from active pipeline views. Exact retention duration and any eventual deletion policy are open decisions (see Section 16).

### 6.6 Inquiry Source Tracking

Each lead records its originating channel (for example: quote request, package planner, contact page, or another public-site entry point) to support attribution and reporting.

### 6.7 Conversion to Client

Conversion is an explicit staff action, normally performed once a lead is Qualified and before a Proposal / ROS is prepared (Sections 5.2 and 8). Converting a lead to Converted to Client status creates or links a Client record using the data already captured on the Lead, without duplicating it. The original Lead record is preserved for historical and audit reference rather than deleted, per the separation rule in Section 5. Conversion never creates a User account, Booking, Payment plan, or Visa case as a side effect (Section 5.1).

### 6.8 Manual Lead Creation

Authorized staff may also create leads manually for inquiries that arrive by phone, walk-in, referral, or other offline channels. Manually created leads record their inquiry source (Section 6.6) and pass through the same duplicate detection (Section 6.2) and lifecycle (Section 6.1) as leads submitted through the public site.

---

## 7. Client Portal Onboarding

The initial release uses **invitation-based signup only**. Public self-service account creation is not part of the initial release.

Invitations are issued for converted Clients (Section 6.7). In the canonical journey (Section 8), an invitation is typically sent once a Proposal / ROS is ready for review, so that proposal review and the client's response happen inside the portal.

### 7.1 Portal Invitation Statuses

| Status | Meaning |
| --- | --- |
| Not Invited | No invitation has been created for this client yet. |
| Invitation Prepared | An invitation has been generated but not yet sent. |
| Invitation Sent | The invitation has been delivered to the client. |
| Invitation Opened | The client has opened the invitation link. |
| Account Activated | The client has completed account setup and can log in. |
| Invitation Expired | The invitation's validity window has passed unused. |
| Invitation Revoked | Staff has manually invalidated the invitation. |

### 7.2 Invitation Rules

- **Time-limited** — every invitation has an expiration window, after which it moves to Invitation Expired.
- **Single-use** — an invitation token can activate exactly one account.
- **Correctly linked** — each invitation is tied to the specific Client record it was issued for, so activation attaches to the correct existing record rather than creating a new one.
- **Resendable without duplication** — staff can resend an invitation; this invalidates the prior token and returns the status to Invitation Sent, without creating a duplicate Client or a duplicate PortalInvitation record.

### 7.3 Invitation Authority

- Admin / Manager, and the Travel Consultant assigned to the client, may prepare, send, resend, and revoke portal invitations.
- Resend and revoke actions are audited with the acting staff account, timestamp, and (for revocation) a reason, consistent with Section 14.9.
- No other role issues or revokes invitations.

---

## 8. Client Journey

```text
Browse public website
  -> Submit inquiry (creates a Lead only; see Section 5.1)
  -> Staff review and outreach
  -> Consultation
  -> Lead qualification
  -> Explicit staff conversion: Lead -> Client (Section 6.7)
  -> Proposal / ROS prepared for the Client (Section 9)
  -> Portal invitation sent (Section 7)
  -> Account activation
  -> Client reviews the current proposal version in the portal
  -> Accept, Decline, or Request Changes
  -> Booking created from the accepted version by explicit staff action
  -> Deposit or payment plan
  -> Conditional visa workflow
  -> Documents and itinerary preparation
  -> Ready for travel
  -> In progress
  -> Completed
```

Portal-based review and acceptance is the canonical and preferred flow. Where a client's response is received outside the portal (for example, before the client has activated an account), staff record it under the controlled fallback in Section 9.1 — the sequence of conversion, proposal versioning, explicit booking creation, and audit rules is the same.

Once a booking exists, payments, documents, visa processing, messaging, and itinerary updates may all progress **in parallel** rather than strictly in sequence — for example, a client may be making installment payments, uploading requested documents, and having a visa case reviewed at the same time.

A visa case is only created when the client or destination actually requires visa assistance; it is never created automatically for every booking (see Section 5.1).

---

## 9. Proposal and ROS Management

- A Travel Consultant creates the initial ROS (Rundown of Service) draft for a Client (created or linked through explicit lead conversion, Section 6.7).
- Every ROS carries a **version number**; each edit after the first creates a new version rather than overwriting the previous one.
- Full **revision history** is retained: every version remains stored and traceable.
- The client sees only the **current client-visible version**; earlier versions become **superseded** but are not deleted.
- The client's response to the current version is always one of exactly three terms, used consistently across the platform: **Accept**, **Decline**, or **Request Changes**.
- A client can **Request Changes**, prompting the consultant to prepare a new version.
- A client can **Accept** or **Decline** the current version.
- Acceptance is **timestamped** and recorded as part of the audit trail.
- Once a version is accepted, it becomes **locked** — it cannot be edited further. Any subsequent change requires a **new revision** to be created and, if needed, re-accepted.
- An accepted version does not itself create a Booking; the Booking is created from the accepted version by an explicit staff action (Sections 5.1 and 5.2).
- The client **cannot directly edit** the ROS; all content changes are made by the Travel Consultant in response to client feedback.

### 9.1 Recording a Response Received Outside the Portal

Portal-based client acceptance is the preferred flow once an account is activated. So that staff can run the full workflow end to end before the client portal exists (Phase 2) — or when a client responds by phone, email, or in person — a response received outside the portal may be recorded under these controls:

- Only the Travel Consultant assigned to that Client, or an Admin / Manager, may record an externally received response.
- The record must capture: the acceptance method (e.g., phone, email, in person), the client's acceptance timestamp, the acting staff account, and a supporting evidence reference — a pointer or identifier to the originating email, call log, or meeting note (for example, a linked Message/MessageAttachment or a brief reference note), not a full copy of the correspondence, unrelated personal information, or identity documents — sufficient for dispute resolution and audit. Full audit history is retained per Section 14.9, consistent with the data-minimization principle in `.claude/rules/database-security.md`.
- The exact **ProposalVersion** the client responded to is identified and, on acceptance, **locked** exactly as in a portal acceptance.
- The record is attributed to the staff member who entered it and must never be represented as the client personally authenticating or acting in the portal.

---

## 10. Support and Messaging

Both the admin dashboard and the client portal include a **Support & Messages** area.

### 10.1 Structure

- **Conversation** — a thread tied to a client (and typically to a specific booking, proposal, or case).
- **Participants** — the assigned Travel Consultant by default, plus an optional Finance participant and/or optional Visa Documentation participant when relevant. Admin / Manager has visibility into all conversations.
- **Messages** — individual entries within a conversation, each with timestamps and read status.
- **Attachments** — files attached to a message.
- **Client-visible messages** vs. **internal staff notes** — a message is either visible to the client or marked as an internal-only note; internal notes are never exposed on the client portal.
- **Assignment-based access** — staff only see conversations for clients/bookings they are assigned to, plus Admin / Manager's full visibility.

### 10.2 Categories

- General Inquiry
- Proposal / ROS
- Booking
- Payment
- Documents
- Visa
- Travel Preparation
- Technical Support

### 10.3 Communication System of Record

For the initial release, the **portal is the communication system of record**. Portal messages generate an email notification containing a secure link back to the relevant portal conversation, so recipients are prompted to reply inside the platform rather than by direct email.

The following are **post-MVP enhancements**, not launch requirements:

- Full inbound email synchronization
- Gmail inbox synchronization
- Facebook Messenger synchronization
- WhatsApp synchronization
- Omnichannel/unified-inbox communication

---

## 11. Payments

### 11.1 Balance Calculation

```text
Confirmed amount paid = Sum of payments currently in Confirmed status
Remaining balance    = Booking total - Confirmed amount paid
```

Only the net amount of currently confirmed, non-reversed, non-refunded payments reduces the remaining balance. Pending, Rejected, Cancelled, and Failed payments never count toward the confirmed amount paid. A payment that was Confirmed but is later **Reversed** or fully **Refunded** stops counting from the moment its status changes — which normally increases the remaining balance by that payment's amount. If a refund should not create a new amount owed (for example, a cancelled service), Finance / Accounting must separately record an approved booking-total or payment-plan adjustment (Section 11.5); the balance formula itself is never bent to achieve that outcome.

**Partial refunds:** A payment that has been only partially refunded remains **Confirmed** — only its cumulative refunded amount is subtracted, and only that refunded amount increases the remaining balance; the rest of that payment's amount continues to count toward the confirmed amount paid. A payment's status becomes **Refunded** only once its cumulative refunds equal its full original amount. A Refunded payment therefore contributes exactly zero to the confirmed amount paid — never a negative amount — and must never be subtracted twice (once by no longer counting its original amount, and again by any separate refund total); the calculation always nets a payment's original amount against its own cumulative refunds together, never the two independently. Original payment and receipt records are preserved unchanged by any refund, partial or full (Section 11.5).

### 11.2 Payment Statuses

| Status | Meaning and effect on balance |
| --- | --- |
| Pending | Awaiting confirmation. Never counts toward confirmed amount paid. |
| Confirmed | Counts toward confirmed amount paid; reduces the remaining balance. |
| Rejected | Not accepted. Never counts. |
| Cancelled | Withdrawn before confirmation. Never counts. |
| Failed | Did not complete. Never counts. |
| Refunded | Money was returned to the client after a valid confirmed payment, in full — see Section 11.1's partial-refund clarification for a payment that has been only partially refunded, which remains Confirmed. Once fully Refunded, the payment no longer counts toward confirmed amount paid; the remaining balance normally increases by the refunded amount. Any exception is handled through a separate approved adjustment (Sections 11.1 and 11.5), never by leaving the refunded payment counted. |
| Reversed | An erroneous or invalid confirmation was corrected or voided. No longer counts toward confirmed amount paid; the remaining balance returns to what it was before the erroneous confirmation. |

### 11.3 Roles and Responsibilities

- **Travel Consultant** proposes commercial terms (deposit amount, installment structure, due dates) as part of booking preparation.
- **Finance / Accounting** reviews and approves the payment plan before it becomes active and client-visible, and subsequently confirms, reverses, refunds, and adjusts payments.
- **Client** views only approved payment plans, confirmed payment history, current balance, and receipts.

### 11.4 Payment Plan Structure

- Deposit requirement
- Installments with due dates
- Grace-period rules for near-due or recently-due installments
- Support for partial payments against an installment

### 11.5 Payment Lifecycle Actions

- **Payment confirmation** — performed by Finance / Accounting only.
- **Payment reversal** — performed by Finance / Accounting only, with a recorded reason. A reversal corrects or voids an erroneous payment confirmation; it does not represent money returned to the client.
- **Payment refund** — performed by Finance / Accounting only. A refund represents money returned to the client after a valid confirmed payment. Every refund records the reason, timestamp, acting user, amount, and before/after values (Section 11.7). Whether a refund produces a refund reference, credit note, or equivalent document is an open implementation detail pending management's choice (Section 16.2).
- **Payment adjustment** — performed by Finance / Accounting only (for example, correcting an amount, applying an approved discount, or recording the approved booking-total/payment-plan change that accompanies a refund which should not create a new amount owed).
- **Official receipts** — generated only for confirmed payments, issued by Finance / Accounting.
- **History preservation** — original receipts and payment records are never deleted. When a payment is refunded or reversed, the payment and its receipt are marked accordingly and the complete history and audit trail are preserved.

### 11.6 Reminders and Overdue Handling

- Payment reminders are sent as an installment's due date approaches and after it has passed.
- Installments may carry a status such as Scheduled, Due, Overdue, Partially Paid, Paid, or Waived, to support reminders and reporting; the final list will be confirmed during implementation planning.

### 11.7 Audit History

Every payment confirmation, reversal, refund, and adjustment is recorded with the acting user, timestamp, reason, and before/after values, consistent with the ActivityLog and AuditLog entities in Section 14.

---

## 12. Documents

### 12.1 Categories and Requirements

Documents are organized by category (for example: identity documents, visa documents, booking-related forms, and proof of payment) and linked to a `DocumentRequirement` that defines what is required for a given booking or visa case.

### 12.2 Document Lifecycle

- Upload
- Preview
- Download
- Replacement
- Version history (a replaced document is retained, not deleted)
- Approval
- Rejection
- Request for replacement

### 12.3 Secure Storage and Access Control

- Secure storage with role-based access, consistent with the boundaries in Section 4 (for example, Finance does not automatically gain access to unrelated visa documents, and Visa Documentation Staff does not automatically gain access to unrelated booking documents).
- Signed or expiring download links rather than permanent public URLs.
- File-size limits and file-type validation on upload.
- Malware scanning on uploaded files.
- Access and download audit logs for every document.

Sensitive files (identity documents, visas, financial documents) must be shared only through secure signed or expiring download links; they must never be sent as ordinary email attachments, since an attachment cannot be revoked once sent.

---

## 13. Admin Dashboard Modules

### 13.1 Dashboard Overview

The dashboard overview may display:

- New inquiries
- Pending quotation requests
- Active clients
- Upcoming departures
- Pending document reviews
- Payments due
- Overdue payments
- Open support requests
- Recent administrative activity
- Important alerts

Dashboard information must respect the current staff member's role and permissions.

### 13.2 Leads, Inquiries, and Quotes

Staff manage leads through the lifecycle, statuses, duplicate detection, and spam controls defined in Section 6. Staff can view submitted information, add internal notes, assign a Travel Consultant, track communication status, and convert a qualified lead into a client (Section 6.7) without creating duplicate records.

### 13.3 Client Management

Each client record may include:

- Full name
- Email address
- Phone number
- Address
- Nationality
- Date of birth
- Emergency contact
- Assigned staff member
- Client status
- Internal notes
- Related leads (historical)
- Related proposals
- Related bookings
- Payment records
- Documents
- Support history

Sensitive fields must only be collected when operationally necessary. A Client record is distinct from the Lead it may have originated from (Section 5).

### 13.4 Booking Management

A booking may contain:

- Booking reference
- Client
- Tour or package
- Destination
- Travel dates
- Number of travellers
- Traveller information
- Booking status
- Total price
- Currency
- Assigned staff
- Itinerary
- Included services
- Excluded services
- Special requests
- Internal notes
- Client-visible notes
- Payment plan
- Required documents
- Visa requirements

Suggested booking statuses:

- Draft
- Pending confirmation
- Confirmed
- In preparation
- Documents required
- Visa processing
- Ready for travel
- In progress
- Completed
- Cancelled

### 13.5 Proposal / ROS

See Section 9 for the full proposal and ROS versioning and acceptance workflow.

### 13.6 Payment Plans

See Section 11 for the full payment plan structure, balance calculation, statuses, and responsibilities.

### 13.7 Documents

See Section 12 for the full document lifecycle and security controls.

### 13.8 Visa Case Management

A visa case is opened only when required (Section 5.1, Section 8) and tracks visa requirements, document reviews specific to the visa application, deadlines, and status progression, managed by Visa Documentation Staff. The detailed visa status list will be finalized alongside implementation planning.

### 13.9 Support & Messages

See Section 10 for conversation structure, participants, categories, and access rules.

---

## 14. Database Entity Planning

The following entities are proposed at a conceptual level. No schema (Prisma or otherwise) is defined yet; this section describes each entity's responsibility so implementation planning can proceed from a shared model.

### 14.1 Identity and Access

- **User** — an authentication account for a staff member or client; holds login credentials and links to a Role.
- **Role** — one of the six defined roles (Section 4), a named collection of permissions.
- **Permission** — a discrete capability (e.g., "confirm payment") that can be associated with a Role.
- **StaffProfile** — staff-specific profile information (name, title, contact details) linked to a User.
- **ClientProfile** — the portal/profile extension for a client, created at account activation and linked to both the Client business record (Section 14.2) and the activated User account. It does not replace the Client record and does not exist before activation.
- **StaffAssignment** — records which staff member is assigned to which lead, client, booking, or visa case, implementing the assignment-based access model.
- **PortalInvitation** — the time-limited, single-use invitation record described in Section 7.

### 14.2 Leads and Clients

- **Lead** — an inquiry record, prior to conversion, as described in Section 5 and Section 6.
- **LeadStatusHistory** — a timestamped record of every status change a Lead has gone through.
- **Client** — the business record for a party with an active or past commercial relationship, created or linked through explicit lead conversion (Section 6.7). A Client exists independently of any User account or ClientProfile and may exist before — or entirely without — portal activation. Proposals, bookings, documents, visa cases, and conversations attach to the Client.

### 14.3 Communication

- **Conversation** — a message thread tied to a client and typically a related record (booking, proposal, visa case).
- **ConversationParticipant** — links a staff member or client to a Conversation with a role in that thread.
- **Message** — an individual message within a Conversation, including client-visible or internal-note status.
- **MessageAttachment** — a file attached to a Message.

### 14.4 Sales

- **Proposal** — the ROS record for a Client, described in Section 9.
- **ProposalVersion** — an individual versioned draft of a Proposal, preserving revision history.
- **ProposalAcceptance** — the record of a client's response (Accept, Decline, or Request Changes — Section 9) to a specific ProposalVersion, always including a response timestamp. A portal-based response additionally links the authenticated client session; a response recorded under the Section 9.1 external fallback additionally captures the response method or channel (e.g., phone, email, in person), the acting staff account, and a supporting evidence reference (a pointer or identifier — e.g., a linked Message/MessageAttachment or a brief reference note — rather than a full copy of correspondence), consistent with the data-minimization principle in `.claude/rules/database-security.md`.

### 14.5 Bookings

- **Booking** — the confirmed commercial engagement created from an accepted Proposal by an explicit staff action, described in Section 5 and Section 13.4.
- **ItineraryVersion** — a versioned itinerary associated with a Booking.
- **TourPackage** — a conceptual catalogue record for the bookable tour or package a Booking references (Section 13.4). It represents the bookable catalogue item only; it does not by itself imply a full tours/website content-management module in the MVP (Sections 15.5 and 16.2).

### 14.6 Payments

- **PaymentPlan** — the deposit/installment structure for a Booking, described in Section 11.
- **Installment** — a single scheduled amount within a PaymentPlan, with a due date and status.
- **Payment** — an individual payment record against an Installment or Booking, with a status (Section 11.2).
- **Receipt** — the official receipt generated for a confirmed Payment.
- **PaymentAdjustment** — a recorded correction or adjustment applied to a Payment or PaymentPlan.

### 14.7 Documents

- **Document** — an uploaded file with category, version, and status, described in Section 12.
- **DocumentRequirement** — defines which document categories are required for a given Booking or VisaCase.
- **DocumentReview** — records a staff review outcome (approved, rejected, replacement requested) for a Document.

### 14.8 Visa

- **VisaCase** — the conditional visa workflow record for a Booking, described in Section 5, Section 8, and Section 13.8.
- **VisaRequirement** — defines what is required for a specific VisaCase (documents, forms, deadlines).
- **VisaStatusHistory** — a timestamped record of every status change a VisaCase has gone through.

### 14.9 System

- **Notification** — a system-generated alert to a User (staff or client) about a relevant event.
- **ActivityLog** — a general record of user actions across the platform, used for operational visibility.
- **AuditLog** — an append-only record of sensitive or security-relevant actions (payment confirmations/reversals/refunds/adjustments, permission changes, role assignments), which no role, including Admin / Manager, can modify (Section 4.2).

---

## 15. Delivery Targets and MVP Scope

### 15.1 Target Dates

- **September 30, 2026** — internal MVP and staging release.
- **October 31, 2026** — production-ready launch.

### 15.2 What MVP Means

MVP means Minimum Viable Product: the smallest complete and secure version of the platform that staff and selected clients can use successfully for real operations.

### 15.3 Included in MVP

- Authentication
- Role-based permissions
- Lead management
- Client management
- Portal invitations
- Admin dashboard
- Client dashboard
- Proposals and ROS versions
- Bookings
- Payment plans
- Payment history and receipts
- Document management
- Conditional visa management
- Portal messaging (Support & Messages)
- Notifications
- Audit logging

### 15.4 Explicitly Outside the Initial MVP

- Full Gmail synchronization
- Full inbound email reply ingestion
- Facebook Messenger integration
- WhatsApp integration
- AI automation
- Advanced business intelligence
- Nonessential animations and cosmetic enhancements
- Full Tours and Packages content management (unless separately approved)
- General website content management (unless separately approved)
- Full System Settings user interface
- Nonessential dashboard customization

### 15.5 Module Scope Classification

Sections 2.2 and 2.3 name modules that are not all part of the initial MVP. The classification below is **approved as part of the Phase 0 structure and workflow baseline** (see `docs/HERITAGE_V3_DECISIONS_LOG.md` D-005 and D-010):

| Module | Classification |
| --- | --- |
| Staff accounts, roles, permissions, and assignments | Required MVP foundation (Phase 1), limited to the management capability necessary to operate the six roles in Section 4. |
| Dashboard overview | MVP — Phase 2. |
| Regional Tours (client portal) | MVP — Phase 3, as a read-only reuse of, or link to, the existing V2 public tour catalogue. Not a new protected business-data module. |
| Basic finance exports (Section 4.4) | MVP — Phase 4, delivered with the payment work. |
| Full Tours and Packages content management | Deferred unless separately approved. |
| General Website Content management | Deferred unless separately approved. |
| Advanced Reports / business intelligence | Post-MVP (Section 15.4). |
| Full System Settings user interface | Post-MVP. Configuration the MVP needs is handled through controlled environment or deployment configuration, not an in-app settings UI. |
| Nonessential dashboard customization and cosmetic enhancements | Post-MVP (Section 15.4). |

---

## 16. Naming and Open Decisions

### 16.1 Naming

The official project name remains **Heritage Philippines V3**. The repository, folders, files, and product branding are not being renamed.

The names "Heritage Homecoming Philippines" and "HHP" appeared in revision notes during Phase 0 planning discussions. This is noted for the record only — the official public product name has **not** been changed or approved, and no renaming should be carried out based on this note alone.

### 16.2 Other Open Decisions

The following items are recognized as unresolved and should be settled before or during the phases that depend on them:

- Exact invitation expiration duration (Section 7.2).
- Exact lead archive/retention duration and any eventual deletion policy (Section 6.5).
- Whether public self-service portal signup will be introduced in a later phase, beyond invitation-only onboarding (Section 7).
- Whether a dedicated Content Manager role should be introduced if website-content workload grows beyond what Admin / Manager can reasonably cover (Section 4.7).
- Final installment/overdue status list (Section 11.6).
- Final visa case status list (Section 13.8).
- Lead assignment rule (manual assignment vs. an automated rule such as round robin), currently assumed manual by default (Section 6.4).
- **Technology stack** — Accepted July 9, 2026 via `docs/adr/ADR-001-technology-stack.md` (TypeScript, Node.js, Next.js, PostgreSQL, Prisma, Zod, pnpm, modular monolith); see `docs/HERITAGE_V3_DECISIONS_LOG.md` D-001. No longer an open decision; retained here for historical traceability of this decision register.
- **Currency strategy** — proposed: the Philippine peso (PHP) is the single billing currency for the MVP, with the Booking currency field (Section 13.4) fixed to it and multi-currency support deferred. This proposal is **pending explicit stakeholder approval**; it affects Phase 1 schema design and blocks Phase 4 payment work.
- **Retention periods** for documents, activity logs, audit logs, and other personal data — unresolved pending the privacy/compliance review below. No final retention or deletion durations have been set.
- **Philippine privacy/compliance posture** — applicability of the Data Privacy Act of 2012 and related obligations, consent requirements, breach-response planning, and the retention policy above. Requires stakeholder/legal review before Phase 6 (Security and Production Hardening).
- **Refund documentation type** — whether a refund produces a refund reference, credit note, or equivalent record (Section 11.5); an open implementation detail until management selects the document type.

---
