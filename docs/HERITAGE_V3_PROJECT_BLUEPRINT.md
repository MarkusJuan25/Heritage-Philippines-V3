# Heritage Philippines V3 Project Blueprint

## Document Status

- Project: Heritage Philippines V3
- Status: Planning (Phase 0)
- Repository: Heritage-Philippines-V3
- Primary branch: `main`
- Foundation: Heritage Philippines V2
- Last updated: July 8, 2026
- Revision notes: Incorporates approved role, domain-model, lead lifecycle, portal onboarding, client journey, proposal/ROS, messaging, payments, documents, database, and delivery-target planning decisions.

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

### 4.2 Admin / Manager

Admin / Manager holds full operational oversight of the business but is not a platform-security role.

Capabilities:

- Full visibility across leads, clients, proposals, bookings, payment plans, documents, and visa cases
- Manage staff accounts' operational role assignments and lead/client/booking assignments
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
- Propose commercial terms (deposit, installments, due dates) for a payment plan
- View payment progress for their assigned bookings (read-only)

Explicit boundaries:

- Cannot confirm payments
- Cannot reverse payments
- Cannot issue official receipts

### 4.4 Finance / Accounting

Finance / Accounting manages the financial lifecycle of a booking.

Capabilities:

- Review and approve payment plans proposed by Travel Consultants
- Manage deposits, installments, and due dates
- Confirm, reverse, and adjust payments
- Issue official receipts
- Track balances, overdue installments, and payment history
- Export financial reports

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

- Cannot confirm payments
- Cannot edit bookings unrelated to their assigned visa cases

### 4.6 Client

Clients may only access records that belong to their own account.

Capabilities:

- View and manage their own profile and settings
- View their proposals/ROS and respond (accept, decline, request changes)
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
- **Proposal / ROS (Rundown of Service)** — A versioned travel plan and quotation prepared by a Travel Consultant for a Lead or Client.
- **Booking** — A confirmed commercial engagement created once a Proposal / ROS is accepted.
- **Payment plan** — The financial arrangement (deposit, installments, due dates) associated with a Booking.
- **Visa case** — A conditional workflow record created only when visa assistance is required for a Client's Booking or destination.

### 5.1 Non-Automatic Creation Rule

An inquiry must **not** automatically create a portal user, client account, booking, payment plan, or visa case. Each of these records is created deliberately, at the appropriate point in the journey, by an explicit staff or system action — never as a side effect of an inquiry being submitted.

### 5.2 Conceptual Relationship

```text
Lead --(qualification)--> Client --(invitation + activation)--> User Account (portal access)
Client --(consultant drafts)--> Proposal / ROS --(client acceptance)--> Booking
Booking --(Finance approval)--> Payment Plan
Booking --(conditional, only if required)--> Visa Case
```

A Lead can exist, be contacted, and even receive a Proposal without a User account, Booking, Payment plan, or Visa case ever being created — those only come into existence once the journey actually reaches that point.

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
| Proposal in Preparation | A Travel Consultant is drafting a Proposal / ROS. |
| Proposal Sent | A proposal has been delivered to the lead for review. |
| Awaiting Decision | The lead is reviewing the proposal; no response yet. |
| Converted to Client | The lead has accepted and become a Client (see 6.7). |
| Not Proceeding | The lead declined or is no longer interested. |
| Duplicate | Identified as a repeat submission of an existing lead or client. |
| Spam | Identified as a non-genuine or abusive submission. |
| Archived | Inactive lead retained per retention rules and excluded from active pipelines. |

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

Converting a lead to Converted to Client status creates or links a Client record using the data already captured on the Lead, without duplicating it. The original Lead record is preserved for historical and audit reference rather than deleted, per the separation rule in Section 5.

---

## 7. Client Portal Onboarding

The initial release uses **invitation-based signup only**. Public self-service account creation is not part of the initial release.

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
- **Correctly linked** — each invitation is tied to the specific Lead or Client record it was issued for, so activation attaches to the correct existing record rather than creating a new one.
- **Resendable without duplication** — staff can resend an invitation; this invalidates the prior token and returns the status to Invitation Sent, without creating a duplicate Client or a duplicate PortalInvitation record.

---

## 8. Client Journey

```text
Browse public website
  -> Submit inquiry
  -> Lead qualification
  -> Consultation
  -> Proposal / ROS
  -> Client review
  -> Accept, decline, or request changes
  -> Portal invitation
  -> Account activation
  -> Booking
  -> Deposit or payment plan
  -> Conditional visa workflow
  -> Documents and itinerary preparation
  -> Ready for travel
  -> In progress
  -> Completed
```

Once a booking exists, payments, documents, visa processing, messaging, and itinerary updates may all progress **in parallel** rather than strictly in sequence — for example, a client may be making installment payments, uploading requested documents, and having a visa case reviewed at the same time.

A visa case is only created when the client or destination actually requires visa assistance; it is never created automatically for every booking (see Section 5.1).

---

## 9. Proposal and ROS Management

- A Travel Consultant creates the initial ROS (Rundown of Service) draft for a lead or client.
- Every ROS carries a **version number**; each edit after the first creates a new version rather than overwriting the previous one.
- Full **revision history** is retained: every version remains stored and traceable.
- The client sees only the **current client-visible version**; earlier versions become **superseded** but are not deleted.
- A client can **request changes**, prompting the consultant to prepare a new version.
- A client can **accept** or **reject** the current version.
- Acceptance is **timestamped** and recorded as part of the audit trail.
- Once a version is accepted, it becomes **locked** — it cannot be edited further. Any subsequent change requires a **new revision** to be created and, if needed, re-accepted.
- The client **cannot directly edit** the ROS; all content changes are made by the Travel Consultant in response to client feedback.

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
Confirmed amount paid = Sum of confirmed payments only
Remaining balance    = Booking total - Confirmed amount paid
```

Pending, rejected, cancelled, failed, refunded, or reversed payments must **not** reduce the remaining balance. Only payments in the Confirmed status count toward the confirmed amount paid.

### 11.2 Payment Statuses

| Status | Effect on balance |
| --- | --- |
| Pending | No effect — awaiting confirmation. |
| Confirmed | Reduces remaining balance. |
| Rejected | No effect. |
| Cancelled | No effect. |
| Failed | No effect. |
| Refunded | No effect (does not restore balance owed). |
| Reversed | No effect (previously confirmed payment reversed; balance returns to unpaid). |

### 11.3 Roles and Responsibilities

- **Travel Consultant** proposes commercial terms (deposit amount, installment structure, due dates) as part of booking preparation.
- **Finance / Accounting** reviews and approves the payment plan before it becomes active and client-visible, and subsequently confirms, reverses, and adjusts payments.
- **Client** views only approved payment plans, confirmed payment history, current balance, and receipts.

### 11.4 Payment Plan Structure

- Deposit requirement
- Installments with due dates
- Grace-period rules for near-due or recently-due installments
- Support for partial payments against an installment

### 11.5 Payment Lifecycle Actions

- **Payment confirmation** — performed by Finance / Accounting only.
- **Payment reversal** — performed by Finance / Accounting only, with a recorded reason.
- **Payment adjustment** — performed by Finance / Accounting only (for example, correcting an amount or applying an approved discount).
- **Official receipts** — generated only for confirmed payments, issued by Finance / Accounting.

### 11.6 Reminders and Overdue Handling

- Payment reminders are sent as an installment's due date approaches and after it has passed.
- Installments may carry a status such as Scheduled, Due, Overdue, Partially Paid, Paid, or Waived, to support reminders and reporting; the final list will be confirmed during implementation planning.

### 11.7 Audit History

Every payment confirmation, reversal, and adjustment is recorded with the acting user, timestamp, reason, and before/after values, consistent with the ActivityLog and AuditLog entities in Section 14.

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

For sensitive files (identity documents, visas, financial documents), a secure expiring download link is recommended over sending the file as an ordinary email attachment, since email attachments cannot be revoked once sent.

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
- **ClientProfile** — client-specific profile information linked to a User and to the Client business record.
- **StaffAssignment** — records which staff member is assigned to which lead, client, booking, or visa case, implementing the assignment-based access model.
- **PortalInvitation** — the time-limited, single-use invitation record described in Section 7.

### 14.2 Leads

- **Lead** — an inquiry record, prior to conversion, as described in Section 5 and Section 6.
- **LeadStatusHistory** — a timestamped record of every status change a Lead has gone through.

### 14.3 Communication

- **Conversation** — a message thread tied to a client and typically a related record (booking, proposal, visa case).
- **ConversationParticipant** — links a staff member or client to a Conversation with a role in that thread.
- **Message** — an individual message within a Conversation, including client-visible or internal-note status.
- **MessageAttachment** — a file attached to a Message.

### 14.4 Sales

- **Proposal** — the ROS record for a lead or client, described in Section 9.
- **ProposalVersion** — an individual versioned draft of a Proposal, preserving revision history.
- **ProposalAcceptance** — the timestamped record of a client's acceptance of a specific ProposalVersion.

### 14.5 Bookings

- **Booking** — the confirmed commercial engagement created from an accepted Proposal, described in Section 5 and Section 13.4.
- **ItineraryVersion** — a versioned itinerary associated with a Booking.

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
- **AuditLog** — an append-only record of sensitive or security-relevant actions (payment confirmations/reversals, permission changes, role assignments), which no role, including Admin / Manager, can modify (Section 4.2).

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

---
