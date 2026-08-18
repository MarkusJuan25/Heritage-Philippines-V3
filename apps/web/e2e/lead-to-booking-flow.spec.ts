import { randomUUID } from 'node:crypto';

import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient, type E2EPrismaRpcClient } from './support/test-database';

// D-033: the canonical real-Chromium, real-database, real-admin-surface
// journey. Exactly one test-created TRAVEL_CONSULTANT throughout — no
// ADMIN_MANAGER participates, and no second unauthorized TC case is
// added (D-033 §3, Correction Pass 3 §9). No mocked authentication,
// session, actor, component, route, service, repository, or persistence
// is used anywhere below.

function extractTrailingId(url: string): string {
  const match = /\/([0-9a-fA-F-]{36})\/?(?:\?.*)?$/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id) {
    throw new Error(`Could not extract a UUID from URL: ${url}`);
  }
  return id;
}

function formatDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type AuditRow = {
  action: string;
  actorId: string;
  entityType: string;
  entityId: string;
  afterState: unknown;
};

function afterStateOf(row: AuditRow): Record<string, unknown> {
  const value = row.afterState;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object afterState snapshot for ${row.action}.`);
  }
  return value as Record<string, unknown>;
}

function findExactlyOneAudit(rows: AuditRow[], action: string, entityId: string): AuditRow {
  const matches = rows.filter((row) => row.action === action && row.entityId === entityId);
  expect(matches, `expected exactly one ${action} row for entity ${entityId}`).toHaveLength(1);
  const [row] = matches;
  if (!row) {
    throw new Error(`Expected exactly one ${action} AuditLog row for entity ${entityId}.`);
  }
  return row;
}

// --- Runtime narrowing for the RPC bridge's `unknown` transported results
// (Stage 2 Correction Pass 2). JSON transport does not preserve genuine
// Prisma return-value semantics, so no result is ever accessed without
// first being validated into one of these minimal, exactly-as-used shapes.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected an object result for ${context}, got ${typeof value}.`);
  }
  return value;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array result for ${context}, got ${typeof value}.`);
  }
  return value;
}

function asString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`Expected string field "${field}" on ${context}, got ${typeof value}.`);
  }
  return value;
}

function asStringOrNull(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  const value = record[field];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Expected string or null field "${field}" on ${context}, got ${typeof value}.`);
  }
  return value;
}

type NarrowLead = { id: string; clientId: string | null };
function narrowLead(value: unknown): NarrowLead {
  const record = asRecord(value, 'Lead');
  return {
    id: asString(record, 'id', 'Lead'),
    clientId: asStringOrNull(record, 'clientId', 'Lead'),
  };
}

type NarrowClient = { id: string };
function narrowClient(value: unknown): NarrowClient {
  const record = asRecord(value, 'Client');
  return { id: asString(record, 'id', 'Client') };
}

type NarrowProposalVersion = {
  id: string;
  proposalId: string;
  clientVisibleAt: string | null;
  supersededAt: string | null;
};
function narrowProposalVersion(value: unknown): NarrowProposalVersion {
  const record = asRecord(value, 'ProposalVersion');
  return {
    id: asString(record, 'id', 'ProposalVersion'),
    proposalId: asString(record, 'proposalId', 'ProposalVersion'),
    clientVisibleAt: asStringOrNull(record, 'clientVisibleAt', 'ProposalVersion'),
    supersededAt: asStringOrNull(record, 'supersededAt', 'ProposalVersion'),
  };
}

type NarrowProposal = { id: string; clientId: string; versions: NarrowProposalVersion[] };
function narrowProposal(value: unknown): NarrowProposal {
  const record = asRecord(value, 'Proposal');
  const versions = asArray(record.versions, 'Proposal.versions').map(narrowProposalVersion);
  return {
    id: asString(record, 'id', 'Proposal'),
    clientId: asString(record, 'clientId', 'Proposal'),
    versions,
  };
}

type NarrowAcceptance = { proposalVersionId: string; responseType: string };
function narrowAcceptance(value: unknown): NarrowAcceptance {
  const record = asRecord(value, 'ProposalAcceptance');
  return {
    proposalVersionId: asString(record, 'proposalVersionId', 'ProposalAcceptance'),
    responseType: asString(record, 'responseType', 'ProposalAcceptance'),
  };
}

type NarrowBooking = { id: string; clientId: string; proposalVersionId: string };
function narrowBooking(value: unknown): NarrowBooking {
  const record = asRecord(value, 'Booking');
  return {
    id: asString(record, 'id', 'Booking'),
    clientId: asString(record, 'clientId', 'Booking'),
    proposalVersionId: asString(record, 'proposalVersionId', 'Booking'),
  };
}

type NarrowAssignment = { assignedStaffId: string; endedAt: string | null };
function narrowAssignmentOrNull(value: unknown, context: string): NarrowAssignment | null {
  if (value === null) return null;
  const record = asRecord(value, context);
  return {
    assignedStaffId: asString(record, 'assignedStaffId', context),
    endedAt: asStringOrNull(record, 'endedAt', context),
  };
}

type NarrowStatusHistoryRow = {
  previousStatus: string | null;
  newStatus: string;
  changedByUserId: string;
};
function narrowStatusHistoryRows(value: unknown, context: string): NarrowStatusHistoryRow[] {
  return asArray(value, context).map((row) => {
    const record = asRecord(row, context);
    return {
      previousStatus: asStringOrNull(record, 'previousStatus', context),
      newStatus: asString(record, 'newStatus', context),
      changedByUserId: asString(record, 'changedByUserId', context),
    };
  });
}

function narrowAuditRows(value: unknown): AuditRow[] {
  return asArray(value, 'AuditLog').map((row, index) => {
    const record = asRecord(row, `AuditLog[${index}]`);
    return {
      action: asString(record, 'action', `AuditLog[${index}]`),
      actorId: asString(record, 'actorId', `AuditLog[${index}]`),
      entityType: asString(record, 'entityType', `AuditLog[${index}]`),
      entityId: asString(record, 'entityId', `AuditLog[${index}]`),
      afterState: record.afterState,
    };
  });
}

test('completes the full Lead → Client → Proposal → Booking journey through the real admin surfaces (D-033)', async ({
  page,
  tcAccount,
}) => {
  const leadFullName = `E2E Lead ${randomUUID()}`;
  const leadSource = 'E2E automated journey';
  const leadEmail = `e2e-lead-${randomUUID()}@example.test`;

  // 1. Log in through /login using the real test credential.
  await page.goto('/login');
  await page.getByLabel('Email').fill(tcAccount.email);
  await page.getByLabel('Password').fill(tcAccount.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/admin');

  // 2. Create a Lead through /admin/leads/new. `exact: true` avoids
  // Playwright's substring accessible-name matching also selecting the
  // Dashboard Overview's "View all leads" link (D-029).
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/admin/leads');
  await page.getByRole('link', { name: 'New Lead' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/leads/new');

  await page.getByLabel('Full name').fill(leadFullName);
  await page.getByLabel('Source').fill(leadSource);
  await page.getByLabel('Email').fill(leadEmail);
  await page.getByRole('button', { name: 'Create Lead' }).click();
  await expect(page.getByRole('status')).toContainText(`Lead ${leadFullName} was created.`);

  await page.getByRole('link', { name: 'View Lead' }).click();
  await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname));
  const leadId = extractTrailingId(page.url());

  // 3. Confirm the Lead is atomically self-assigned to the fixture TC.
  const assignmentSummary = await page.getByText('Assigned Consultant:').textContent();
  expect(assignmentSummary).toContain(tcAccount.name);

  // 4. Change the Lead from NEW to QUALIFIED through its admin page.
  await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
  await page.getByRole('button', { name: 'Change Status' }).click();
  await expect(page.getByText('Status updated.')).toBeVisible();

  // 5. Convert the Lead into a new Client through the conversion panel.
  await expect(page.getByRole('heading', { name: 'Convert to Client' })).toBeVisible();
  await page.getByLabel('Create a new Client').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  // ConvertToClientPanel's own success paragraph, unlike
  // PublishProposalVersionButton's/RecordProposalResponsePanel's, is a
  // reliable signal here: once set, this component "permanently shows
  // only the confirmation message" for the rest of its mounted lifetime,
  // and direct testing confirmed the parent's conditional render does not
  // unmount it within any bounded wait — so the transient-looking message
  // is, in practice, durable enough to assert on directly.
  await expect(
    page.getByText(`Converted. A new client, "${leadFullName}", was created.`),
  ).toBeVisible();

  // 6. Confirm navigation and access to the resulting Client.
  await page.getByRole('link', { name: 'Clients', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/admin/clients');
  await page.getByLabel('Search').fill(leadFullName);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  // ClientTable renders both a mobile-card and a desktop-table copy of
  // this link simultaneously (CSS alone toggles which is visible) — the
  // `:visible` CSS pseudo-class selects whichever copy the current
  // viewport actually shows, rather than `.first()`, which would
  // deterministically pick by DOM order regardless of viewport.
  await page.locator('a:visible', { hasText: leadFullName }).click();
  await page.waitForURL((url) => /^\/admin\/clients\/[0-9a-fA-F-]{36}$/.test(url.pathname));
  const clientId = extractTrailingId(page.url());
  await expect(page.getByRole('heading', { name: leadFullName })).toBeVisible();

  // 7. Create a Proposal and first ProposalVersion through the Client
  // admin page.
  const proposalContent = `E2E automated proposal content ${randomUUID()}.`;
  await page.getByLabel('Proposal content').fill(proposalContent);
  await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
  await page.waitForURL((url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname));
  const proposalId = extractTrailingId(page.url());

  // 8. Publish the version through the Proposal admin page.
  await page.getByRole('button', { name: 'Publish Version 1' }).click();
  // Not the button's own transient "Version 1 published." message:
  // ProposalVersionHistory stops rendering PublishProposalVersionButton
  // for this version once it is no longer an eligible draft (i.e. once
  // published), so that message can already be gone by the time a
  // fixed-text assertion polls. Waiting for RecordProposalResponsePanel —
  // rendered only once this version is the current client-visible,
  // no-response version — is the durable, race-free confirmation and the
  // natural precondition for the next step.
  await expect(page.getByRole('heading', { name: 'Record Client Response' })).toBeVisible();

  // 9. Record an external ACCEPT response under blueprint Section 9.1.
  // `exact: true` avoids also matching the "Response method" text input's
  // label, which contains "Response" as a substring.
  await page.getByLabel('Response', { exact: true }).selectOption({ label: 'Accept' });
  await page.getByLabel('Client responded at').fill(formatDatetimeLocal(new Date()));
  await page.getByLabel('Response method').fill('phone');
  const evidenceReference = `E2E evidence ${randomUUID()}`;
  await page.getByLabel('Evidence reference').fill(evidenceReference);
  await page.getByRole('button', { name: 'Record Response for Version 1' }).click();
  // Not the panel's own transient "Response recorded..." message: for the
  // identical reason as the publish step above, ProposalVersionHistory
  // stops rendering RecordProposalResponsePanel once this version has a
  // recorded response. Waiting for CreateBookingButton — rendered only
  // once this version carries an ACCEPT response — is the durable,
  // race-free confirmation and the natural precondition for step 10.
  await expect(page.getByRole('button', { name: 'Create Booking' })).toBeVisible();

  // 10. Create a Booking from the accepted version.
  await page.getByRole('button', { name: 'Create Booking' }).click();
  await page.waitForURL((url) => /^\/admin\/bookings\/[0-9a-fA-F-]{36}$/.test(url.pathname));
  const bookingId = extractTrailingId(page.url());

  // 11. Navigate to, list, and read that Booking.
  await page.getByRole('link', { name: 'Bookings', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/admin/bookings');
  // The list renders both a mobile-card and a desktop-table layout
  // simultaneously (CSS alone toggles which is visible) — the `:visible`
  // CSS pseudo-class selects whichever one the current viewport actually
  // shows, rather than `.first()`, which would deterministically pick the
  // (possibly hidden) mobile-card copy by DOM order regardless of
  // viewport.
  const bookingListLink = page.locator(`a[href="/admin/bookings/${bookingId}"]:visible`);
  await expect(bookingListLink).toBeVisible();
  await bookingListLink.click();
  await page.waitForURL((url) => url.pathname === `/admin/bookings/${bookingId}`);

  // 12. Change the Booking from DRAFT to PENDING_CONFIRMATION through its
  // admin page.
  await expect(page.getByText('Draft')).toBeVisible();
  await page.getByLabel('New status').selectOption({ label: 'Pending Confirmation' });
  await page.getByRole('button', { name: 'Update status' }).click();
  // Not a loose text match: "Pending Confirmation" also appears, hidden,
  // as an `<option>` in the now-refreshed status select (its
  // `allowedTargetStatuses` no longer excludes it once DRAFT is no longer
  // current). Scoping to the `<dd>` status value is the durable,
  // unambiguous, persisted signal — never the transient flash message,
  // which (as with the Proposal panels above) can legitimately have
  // already cleared by the time this assertion polls.
  await expect(page.locator('dd', { hasText: 'Pending Confirmation' })).toBeVisible();

  // --- D-033 §10: direct database assertions, paired with the browser
  // journey above. ---
  const prisma: E2EPrismaRpcClient = createE2EPrismaRpcClient();
  try {
    const lead = narrowLead(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } }));
    const client = narrowClient(await prisma.client.findUniqueOrThrow({ where: { id: clientId } }));
    expect(lead.clientId).toBe(client.id);

    const proposal = narrowProposal(
      await prisma.proposal.findUniqueOrThrow({
        where: { id: proposalId },
        include: { versions: true },
      }),
    );
    expect(proposal.clientId).toBe(client.id);
    expect(proposal.versions).toHaveLength(1);
    const [version] = proposal.versions;
    if (!version) {
      throw new Error('Expected exactly one ProposalVersion.');
    }
    expect(version.proposalId).toBe(proposal.id);
    expect(version.clientVisibleAt).not.toBeNull();
    expect(version.supersededAt).toBeNull();

    const acceptance = narrowAcceptance(
      await prisma.proposalAcceptance.findUniqueOrThrow({
        where: { proposalVersionId: version.id },
      }),
    );
    expect(acceptance.proposalVersionId).toBe(version.id);
    expect(acceptance.responseType).toBe('ACCEPT');

    const booking = narrowBooking(
      await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
    );
    expect(booking.clientId).toBe(client.id);
    expect(booking.proposalVersionId).toBe(version.id);

    // Assignments.
    const leadAssignment = narrowAssignmentOrNull(
      await prisma.staffAssignment.findFirst({ where: { leadId: lead.id } }),
      'Lead StaffAssignment',
    );
    if (!leadAssignment) {
      throw new Error('Expected an active Lead StaffAssignment.');
    }
    expect(leadAssignment.assignedStaffId).toBe(tcAccount.userId);
    expect(leadAssignment.endedAt).toBeNull();

    const clientAssignment = narrowAssignmentOrNull(
      await prisma.staffAssignment.findFirst({ where: { clientId: client.id } }),
      'Client StaffAssignment',
    );
    if (!clientAssignment) {
      throw new Error('Expected an active Client StaffAssignment.');
    }
    expect(clientAssignment.assignedStaffId).toBe(tcAccount.userId);
    expect(clientAssignment.endedAt).toBeNull();

    const bookingAssignment = await prisma.staffAssignment.findFirst({
      where: { bookingId: booking.id },
    });
    expect(bookingAssignment).toBeNull();

    // LeadStatusHistory — exactly three rows. `convertLead` genuinely
    // writes a third row (previousStatus: QUALIFIED, newStatus:
    // CONVERTED_TO_CLIENT), confirmed directly against real Postgres —
    // matching D-024 §6 step (i) exactly. (D-033's own Section 10 text
    // stated conversion writes no such row; that assumption is corrected
    // here against direct, empirical evidence, per this stage's own
    // "never fabricate evidence" discipline.)
    const leadHistory = narrowStatusHistoryRows(
      await prisma.leadStatusHistory.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
      }),
      'LeadStatusHistory',
    );
    expect(leadHistory).toHaveLength(3);
    const [leadHistory0, leadHistory1, leadHistory2] = leadHistory;
    if (!leadHistory0 || !leadHistory1 || !leadHistory2) {
      throw new Error('Expected exactly three LeadStatusHistory rows.');
    }
    expect(leadHistory0.previousStatus).toBeNull();
    expect(leadHistory0.newStatus).toBe('NEW');
    expect(leadHistory0.changedByUserId).toBe(tcAccount.userId);
    expect(leadHistory1.previousStatus).toBe('NEW');
    expect(leadHistory1.newStatus).toBe('QUALIFIED');
    expect(leadHistory1.changedByUserId).toBe(tcAccount.userId);
    expect(leadHistory2.previousStatus).toBe('QUALIFIED');
    expect(leadHistory2.newStatus).toBe('CONVERTED_TO_CLIENT');
    expect(leadHistory2.changedByUserId).toBe(tcAccount.userId);

    // BookingStatusHistory — exactly two rows.
    const bookingHistory = narrowStatusHistoryRows(
      await prisma.bookingStatusHistory.findMany({
        where: { bookingId: booking.id },
        orderBy: { createdAt: 'asc' },
      }),
      'BookingStatusHistory',
    );
    expect(bookingHistory).toHaveLength(2);
    const [bookingHistory0, bookingHistory1] = bookingHistory;
    if (!bookingHistory0 || !bookingHistory1) {
      throw new Error('Expected exactly two BookingStatusHistory rows.');
    }
    expect(bookingHistory0.previousStatus).toBeNull();
    expect(bookingHistory0.newStatus).toBe('DRAFT');
    expect(bookingHistory0.changedByUserId).toBe(tcAccount.userId);
    expect(bookingHistory1.previousStatus).toBe('DRAFT');
    expect(bookingHistory1.newStatus).toBe('PENDING_CONFIRMATION');
    expect(bookingHistory1.changedByUserId).toBe(tcAccount.userId);

    // AuditLog — exactly eleven rows, exact action/actor/entity/linkage.
    // No total or partial timestamp ordering is asserted (D-033 §10,
    // Correction Pass 2 §9/§10).
    const auditRows = narrowAuditRows(
      await prisma.auditLog.findMany({ where: { actorId: tcAccount.userId } }),
    );
    expect(auditRows).toHaveLength(11);
    for (const row of auditRows) {
      expect(row.actorId).toBe(tcAccount.userId);
    }

    const leadCreated = findExactlyOneAudit(auditRows, 'LEAD_CREATED', lead.id);
    expect(leadCreated.entityType).toBe('Lead');
    expect(afterStateOf(leadCreated).status).toBe('NEW');

    const leadAssigned = findExactlyOneAudit(auditRows, 'LEAD_ASSIGNMENT_CREATED', lead.id);
    expect(leadAssigned.entityType).toBe('Lead');
    expect(afterStateOf(leadAssigned).assignedStaffId).toBe(tcAccount.userId);
    expect(afterStateOf(leadAssigned).leadId).toBe(lead.id);

    const leadStatusChanged = findExactlyOneAudit(auditRows, 'LEAD_STATUS_CHANGED', lead.id);
    expect(leadStatusChanged.entityType).toBe('Lead');
    expect(afterStateOf(leadStatusChanged).status).toBe('QUALIFIED');

    const leadConverted = findExactlyOneAudit(auditRows, 'LEAD_CONVERTED_TO_CLIENT', lead.id);
    expect(leadConverted.entityType).toBe('Lead');
    expect(afterStateOf(leadConverted).clientId).toBe(client.id);
    expect(afterStateOf(leadConverted).clientCreated).toBe(true);

    const clientCreated = findExactlyOneAudit(auditRows, 'CLIENT_CREATED', client.id);
    expect(clientCreated.entityType).toBe('Client');
    expect(afterStateOf(clientCreated).sourceLeadId).toBe(lead.id);

    const clientAssigned = findExactlyOneAudit(auditRows, 'CLIENT_ASSIGNMENT_CREATED', client.id);
    expect(clientAssigned.entityType).toBe('Client');
    expect(afterStateOf(clientAssigned).assignedStaffId).toBe(tcAccount.userId);
    expect(afterStateOf(clientAssigned).clientId).toBe(client.id);

    const proposalCreated = findExactlyOneAudit(auditRows, 'PROPOSAL_CREATED', proposal.id);
    expect(proposalCreated.entityType).toBe('Proposal');
    expect(afterStateOf(proposalCreated).clientId).toBe(client.id);
    expect(afterStateOf(proposalCreated).firstVersionId).toBe(version.id);

    const versionPublished = findExactlyOneAudit(
      auditRows,
      'PROPOSAL_VERSION_PUBLISHED',
      version.id,
    );
    expect(versionPublished.entityType).toBe('ProposalVersion');
    expect(afterStateOf(versionPublished).proposalId).toBe(proposal.id);

    const responseRecorded = findExactlyOneAudit(
      auditRows,
      'PROPOSAL_RESPONSE_RECORDED',
      version.id,
    );
    expect(responseRecorded.entityType).toBe('ProposalVersion');
    expect(afterStateOf(responseRecorded).responseType).toBe('ACCEPT');

    const bookingCreated = findExactlyOneAudit(auditRows, 'BOOKING_CREATED', booking.id);
    expect(bookingCreated.entityType).toBe('Booking');
    expect(afterStateOf(bookingCreated).clientId).toBe(client.id);
    expect(afterStateOf(bookingCreated).proposalVersionId).toBe(version.id);

    const bookingStatusChanged = findExactlyOneAudit(
      auditRows,
      'BOOKING_STATUS_CHANGED',
      booking.id,
    );
    expect(bookingStatusChanged.entityType).toBe('Booking');
    expect(afterStateOf(bookingStatusChanged).status).toBe('PENDING_CONFIRMATION');
  } finally {
    await prisma.$disconnect();
  }
});
