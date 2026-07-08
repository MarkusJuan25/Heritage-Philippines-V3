# Heritage Philippines V3 Project Blueprint

## Document Status

- Project: Heritage Philippines V3
- Status: Planning
- Repository: Heritage-Philippines-V3
- Primary branch: `main`
- Foundation: Heritage Philippines V2
- Last updated: July 8, 2026

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
- Quote requests
- Bookings
- Payment plans
- Payments and receipts
- Documents
- Visa processing
- Tours and packages
- Website content
- Support requests
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
- Support
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

## 4. Users and Roles

The exact permissions will be finalized before implementation.

### 4.1 Super Administrator

The Super Administrator should have complete access to the platform.

Possible capabilities:

- Manage all staff accounts
- Assign roles and permissions
- Access all clients and bookings
- Manage payment and document records
- Configure system settings
- Access audit logs
- Manage public website content
- View operational and financial reports

### 4.2 Administrator

Administrators should manage normal daily operations but may have restricted access to sensitive system settings.

Possible capabilities:

- Manage clients
- Manage inquiries and quotations
- Create and update bookings
- Record payments
- Upload receipts
- Review documents
- Manage support requests
- Update selected website content

### 4.3 Finance Staff

Finance staff should focus on payment-related functions.

Possible capabilities:

- View booking totals
- Create payment schedules
- Record payments
- Confirm or reject payment records
- Upload or generate receipts
- View balances and overdue installments
- Export financial reports

Finance staff should not automatically receive access to unrelated sensitive documents.

### 4.4 Travel or Operations Staff

Operations staff should manage travel preparation and booking progress.

Possible capabilities:

- View assigned clients
- Update journey status
- Manage bookings and itineraries
- Request documents
- Update visa-processing stages
- Coordinate regional tours
- Respond to operational support requests

### 4.5 Content Manager

Content managers should manage approved public-site content.

Possible capabilities:

- Tours and packages
- Gallery entries
- Stories
- Contact information
- Selected homepage content
- Frequently asked questions
- Announcements

Content managers should not receive financial or sensitive client access unless separately permitted.

### 4.6 Client

Clients should only access records that belong to their own account.

Possible capabilities:

- View their journey overview
- View bookings and itineraries
- View payment schedules
- View paid and remaining balances
- View payment history
- Download receipts
- Upload requested documents
- Track document review status
- View visa-processing progress
- Create support requests
- Update permitted profile information
- Manage permitted notification and security settings

---

## 5. Admin Dashboard Modules

### 5.1 Dashboard Overview

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

Dashboard information must respect the current staff member’s role and permissions.

### 5.2 Leads, Inquiries, and Quotes

The system should manage leads from public forms.

Suggested stages:

- New
- Reviewing
- Contacted
- Quotation preparing
- Quotation sent
- Follow-up required
- Converted
- Declined
- Closed

Staff should be able to:

- View submitted information
- Add internal notes
- Assign a staff member
- Track communication status
- Link a quote to a client
- Convert an approved quote into a booking
- Preserve the original request for historical reference

### 5.3 Client Management

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
- Related inquiries
- Related quotations
- Related bookings
- Payment records
- Documents
- Support history

Sensitive fields must only be collected when operationally necessary.

### 5.4 Booking Management

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

### 5.5 Payment Plans

Staff should be able to create installment plans for a booking.

A payment plan may contain:

- Booking total
- Required deposit
- Number of installments
- Installment amounts
- Due dates
- Payment instructions
- Grace-period rules
- Internal notes
- Client-visible notes

The system should calculate:

```text
Remaining balance = Booking total - Confirmed payments