import { randomUUID } from 'node:crypto';

import { test as base, expect } from '@playwright/test';
import { generateRandomString, hashPassword } from 'better-auth/crypto';

import { createE2EPrismaRpcClient, type E2EPrismaRpcClient } from './test-database';

// D-033 §4/§7/§9: a real, login-capable TRAVEL_CONSULTANT credential,
// created atomically via the same technique apps/web/prisma/seed.ts and
// features/staff/service.ts's createStaffAccount already use (D-012) — a
// direct Prisma insert of a User plus a linked credential Account, hashed
// with better-auth/crypto's own hashPassword, never routed through the
// disabled public sign-up endpoint. Test-scoped (Option A, D-033 Correction
// Pass 2 §7): a single Playwright fixture owns both setup and,
// failure-safe, teardown — no separate global-setup/global-teardown files.

export type TCAccount = {
  userId: string;
  email: string;
  password: string;
  name: string;
};

type AuditRow = {
  action: string;
  entityType: string;
  entityId: string;
  afterState: unknown;
};

function afterStateOf(row: AuditRow): Record<string, unknown> {
  const value = row.afterState;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime-narrows the RPC bridge's `unknown` `auditLog.findMany` result
 * into `AuditRow[]` before any field access — the transported result is
 * never asserted to already have this shape (Stage 2 Correction Pass 2).
 */
function narrowAuditRows(value: unknown): AuditRow[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected an array of AuditLog rows from the E2E RPC bridge.');
  }
  return value.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`Expected an AuditLog row object at index ${index}.`);
    }
    const { action, entityType, entityId, afterState } = row;
    if (
      typeof action !== 'string' ||
      typeof entityType !== 'string' ||
      typeof entityId !== 'string'
    ) {
      throw new Error(`Malformed AuditLog row at index ${index}: missing a required string field.`);
    }
    return { action, entityType, entityId, afterState };
  });
}

/**
 * Failure-safe, test-scoped cleanup rooted in the fixture TC's unique User
 * id (D-033 §9, Correction Pass 3 §I). Rediscovers every committed entity
 * id from the actor's own AuditLog rows — never relying solely on ids the
 * spec happened to capture during the browser journey, since a UI action
 * can commit and then fail before its result is ever read back — and
 * deletes only those exact, recovered ids in the verified FK-safe order.
 * The entire discovery-through-deletion sequence is covered by one
 * sanitized failure path — a failure during discovery or id extraction is
 * reported exactly like a failure during deletion (Stage 2 Correction
 * Pass 2), never as a raw, unsanitized error.
 */
async function cleanupTestChain(prisma: E2EPrismaRpcClient, actorId: string): Promise<void> {
  const leadIdList: string[] = [];
  const clientIdList: string[] = [];
  const proposalIdList: string[] = [];
  const versionIdList: string[] = [];
  const bookingIdList: string[] = [];

  try {
    const auditRows = narrowAuditRows(
      await prisma.auditLog.findMany({
        where: { actorId },
        select: { action: true, entityType: true, entityId: true, afterState: true },
      }),
    );

    const leadIds = new Set<string>();
    const clientIds = new Set<string>();
    const proposalIds = new Set<string>();
    const versionIds = new Set<string>();
    const bookingIds = new Set<string>();

    for (const row of auditRows) {
      if (row.entityType === 'Lead') leadIds.add(row.entityId);
      if (row.entityType === 'Client') clientIds.add(row.entityId);
      if (row.entityType === 'Proposal') proposalIds.add(row.entityId);
      if (row.entityType === 'ProposalVersion') versionIds.add(row.entityId);
      if (row.entityType === 'Booking') bookingIds.add(row.entityId);

      const after = afterStateOf(row);
      if (row.action === 'LEAD_CONVERTED_TO_CLIENT' && typeof after.clientId === 'string') {
        clientIds.add(after.clientId);
      }
      if (row.action === 'PROPOSAL_CREATED' && typeof after.firstVersionId === 'string') {
        versionIds.add(after.firstVersionId);
      }
    }

    leadIdList.push(...leadIds);
    clientIdList.push(...clientIds);
    proposalIdList.push(...proposalIds);
    versionIdList.push(...versionIds);
    bookingIdList.push(...bookingIds);

    // 1. AuditLog — the fixture actor is unique to this test run, so
    // filtering by its exact actorId alone can never select another run's
    // data, and (per the canonical journey's own single-actor design,
    // D-033 §3) every audit row this chain writes is already attributed to
    // this actor.
    await prisma.auditLog.deleteMany({ where: { actorId } });

    // 2. BookingStatusHistory
    await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookingIdList } } });

    // 3. StaffAssignment
    await prisma.staffAssignment.deleteMany({
      where: {
        OR: [
          { leadId: { in: leadIdList } },
          { clientId: { in: clientIdList } },
          { bookingId: { in: bookingIdList } },
          { assignedStaffId: actorId },
          { assignedByUserId: actorId },
        ],
      },
    });

    // 4. Booking
    await prisma.booking.deleteMany({ where: { id: { in: bookingIdList } } });

    // 5. ProposalAcceptance
    await prisma.proposalAcceptance.deleteMany({
      where: { proposalVersionId: { in: versionIdList } },
    });

    // 6. ProposalVersion
    await prisma.proposalVersion.deleteMany({ where: { id: { in: versionIdList } } });

    // 7. Proposal
    await prisma.proposal.deleteMany({ where: { id: { in: proposalIdList } } });

    // 8. LeadStatusHistory
    await prisma.leadStatusHistory.deleteMany({ where: { leadId: { in: leadIdList } } });

    // 9. Lead
    await prisma.lead.deleteMany({ where: { id: { in: leadIdList } } });

    // 10. Client
    await prisma.client.deleteMany({ where: { id: { in: clientIdList } } });

    // 11. User last — Account and Session cascade-delete automatically
    // (onDelete: Cascade on both, apps/web/prisma/schema.prisma).
    await prisma.user.deleteMany({ where: { id: actorId } });
  } catch (error) {
    // A cleanup failure — during discovery, id extraction, or deletion
    // alike — must fail the run while reporting only non-sensitive
    // fixture/entity ids already recovered so far and a safe error class
    // name — never the original raw error message, credentials, or PII
    // (D-033 §9, Stage 2 Correction Pass 2).
    const className = error instanceof Error ? error.constructor.name : typeof error;
    const ids = {
      actorId,
      leadIds: leadIdList,
      clientIds: clientIdList,
      proposalIds: proposalIdList,
      versionIds: versionIdList,
      bookingIds: bookingIdList,
    };
    throw new Error(
      `E2E fixture cleanup failed (${className}). Manual remediation may be required for the following ids: ${JSON.stringify(ids)}.`,
    );
  }
}

type Fixtures = {
  tcAccount: TCAccount;
};

export const test = base.extend<Fixtures>({
  // Playwright statically parses this signature to determine fixture
  // dependencies — the first parameter must be a literal (even empty)
  // destructuring pattern; this fixture depends on no other fixture.
  tcAccount: async ({}, use) => {
    const prisma = createE2EPrismaRpcClient();
    const userId = randomUUID();
    const email = `e2e-tc-${randomUUID()}@example.test`;
    const name = `E2E Travel Consultant ${randomUUID()}`;
    // Generated once, held only in this closure and handed directly to the
    // test — never persisted, logged, or placed in an environment
    // variable, filename, report, or diff (D-033 §4).
    const password = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    try {
      const passwordHash = await hashPassword(password);

      // Atomic via Prisma's own nested-write guarantee (a single `create`
      // with a nested `accounts.create` commits as one operation, exactly
      // mirroring `prisma/seed.ts`'s identical, already-accepted D-012
      // technique) — no separate `$transaction()` wrapper is needed, so no
      // partial (User-without-Account) state can ever exist (D-033 §7).
      await prisma.user.create({
        data: {
          id: userId,
          name,
          email,
          emailVerified: true,
          role: 'TRAVEL_CONSULTANT',
          isActive: true,
          accounts: {
            create: {
              id: randomUUID(),
              accountId: userId,
              providerId: 'credential',
              password: passwordHash,
            },
          },
        },
      });

      // Playwright's own fixture-provider convention, not React's `use`
      // hook — eslint-plugin-react-hooks pattern-matches on the bare
      // identifier name `use` and false-positives here.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      await use({ userId, email, password, name });
    } finally {
      try {
        await cleanupTestChain(prisma, userId);
      } finally {
        await prisma.$disconnect();
      }
    }
  },
});

export { expect };
