import { describe, expect, it } from 'vitest';

import { ProposalResponseType } from '@/generated/prisma/client';

import {
  PROPOSAL_AUDIT_ACTIONS,
  PROPOSAL_AUDIT_ENTITY_TYPE,
  sanitizeProposalCreatedSnapshot,
  sanitizeProposalResponseRecordedSnapshot,
  sanitizeProposalVersionCreatedSnapshot,
  sanitizeProposalVersionPublishedSnapshot,
} from './audit';

describe('PROPOSAL_AUDIT_ACTIONS', () => {
  it('defines exactly the four D-027 §9 action constants, each equal to its own key', () => {
    expect(PROPOSAL_AUDIT_ACTIONS).toEqual({
      PROPOSAL_CREATED: 'PROPOSAL_CREATED',
      PROPOSAL_VERSION_CREATED: 'PROPOSAL_VERSION_CREATED',
      PROPOSAL_VERSION_PUBLISHED: 'PROPOSAL_VERSION_PUBLISHED',
      PROPOSAL_RESPONSE_RECORDED: 'PROPOSAL_RESPONSE_RECORDED',
    });
    expect(Object.keys(PROPOSAL_AUDIT_ACTIONS).sort()).toEqual(
      [
        'PROPOSAL_CREATED',
        'PROPOSAL_VERSION_CREATED',
        'PROPOSAL_VERSION_PUBLISHED',
        'PROPOSAL_RESPONSE_RECORDED',
      ].sort(),
    );
  });
});

describe('PROPOSAL_AUDIT_ENTITY_TYPE', () => {
  it('defines exactly the Proposal and ProposalVersion entity types D-027 §9 names', () => {
    expect(PROPOSAL_AUDIT_ENTITY_TYPE).toEqual({
      PROPOSAL: 'Proposal',
      PROPOSAL_VERSION: 'ProposalVersion',
    });
    expect(Object.keys(PROPOSAL_AUDIT_ENTITY_TYPE).sort()).toEqual(
      ['PROPOSAL', 'PROPOSAL_VERSION'].sort(),
    );
  });
});

const ACCEPTANCE_ID = 'acceptance-1';
const PROPOSAL_ID = 'proposal-1';
const VERSION_ID = 'version-1';
const CLIENT_ID = 'client-1';

describe('sanitizeProposalCreatedSnapshot', () => {
  it('picks only clientId, firstVersionId, and firstVersionNumber', () => {
    const snapshot = sanitizeProposalCreatedSnapshot({
      clientId: CLIENT_ID,
      firstVersionId: VERSION_ID,
      firstVersionNumber: 1,
    });

    expect(snapshot).toEqual({
      clientId: CLIENT_ID,
      firstVersionId: VERSION_ID,
      firstVersionNumber: 1,
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['clientId', 'firstVersionId', 'firstVersionNumber'].sort(),
    );
  });

  it('never emits content, Client PII, credentials, or other unexpected fields from a widened source record', () => {
    const widened = {
      clientId: CLIENT_ID,
      firstVersionId: VERSION_ID,
      firstVersionNumber: 1,
      content: 'Day 1: Arrival. Contact +63 917 555 0100.',
      client: { fullName: 'Jordan Cruz', email: 'jordan.cruz@example.test' },
      apiKey: 'not-a-real-api-key',
    };

    const snapshot = sanitizeProposalCreatedSnapshot(widened);

    expect(snapshot).not.toHaveProperty('content');
    expect(snapshot).not.toHaveProperty('client');
    expect(snapshot).not.toHaveProperty('apiKey');
    expect(JSON.stringify(snapshot)).not.toContain('Day 1: Arrival');
    expect(JSON.stringify(snapshot)).not.toContain('Jordan Cruz');
    expect(JSON.stringify(snapshot)).not.toContain('jordan.cruz@example.test');
    expect(JSON.stringify(snapshot)).not.toContain('not-a-real-api-key');
  });
});

describe('sanitizeProposalVersionCreatedSnapshot', () => {
  it('picks only proposalId and versionNumber', () => {
    const snapshot = sanitizeProposalVersionCreatedSnapshot({
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
    });

    expect(snapshot).toEqual({ proposalId: PROPOSAL_ID, versionNumber: 2 });
    expect(Object.keys(snapshot).sort()).toEqual(['proposalId', 'versionNumber'].sort());
  });

  it('never emits content, createdByUserId, or other unexpected fields from a widened source record', () => {
    const widened = {
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      content: 'Revised itinerary. Passport number P1234567.',
      createdByUserId: 'staff-1',
      id: VERSION_ID,
    };

    const snapshot = sanitizeProposalVersionCreatedSnapshot(widened);

    expect(snapshot).not.toHaveProperty('content');
    expect(snapshot).not.toHaveProperty('createdByUserId');
    expect(snapshot).not.toHaveProperty('id');
    expect(JSON.stringify(snapshot)).not.toContain('P1234567');
  });
});

describe('sanitizeProposalVersionPublishedSnapshot', () => {
  it('picks only proposalId, versionNumber, and previousCurrentVersionId', () => {
    const snapshot = sanitizeProposalVersionPublishedSnapshot({
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      previousCurrentVersionId: VERSION_ID,
    });

    expect(snapshot).toEqual({
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      previousCurrentVersionId: VERSION_ID,
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['proposalId', 'versionNumber', 'previousCurrentVersionId'].sort(),
    );
  });

  it('accepts a null previousCurrentVersionId when no version was previously current — D-027 §5\'s "no current version" case', () => {
    const snapshot = sanitizeProposalVersionPublishedSnapshot({
      proposalId: PROPOSAL_ID,
      versionNumber: 1,
      previousCurrentVersionId: null,
    });

    expect(snapshot.previousCurrentVersionId).toBeNull();
  });

  it('never emits content or other unexpected fields from a widened source record', () => {
    const widened = {
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      previousCurrentVersionId: VERSION_ID,
      content: 'Published itinerary content, day-by-day.',
      clientVisibleAt: new Date('2026-08-04T10:00:00.000Z'),
    };

    const snapshot = sanitizeProposalVersionPublishedSnapshot(widened);

    expect(snapshot).not.toHaveProperty('content');
    expect(snapshot).not.toHaveProperty('clientVisibleAt');
    expect(JSON.stringify(snapshot)).not.toContain('Published itinerary content');
  });
});

describe('sanitizeProposalResponseRecordedSnapshot', () => {
  const respondedAt = new Date('2026-08-04T10:00:00.000Z');

  it('picks only acceptanceId, responseType, and respondedAt, serializing respondedAt to an ISO string', () => {
    const snapshot = sanitizeProposalResponseRecordedSnapshot({
      acceptanceId: ACCEPTANCE_ID,
      responseType: ProposalResponseType.ACCEPT,
      respondedAt,
    });

    expect(snapshot).toEqual({
      acceptanceId: ACCEPTANCE_ID,
      responseType: ProposalResponseType.ACCEPT,
      respondedAt: '2026-08-04T10:00:00.000Z',
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['acceptanceId', 'responseType', 'respondedAt'].sort(),
    );
  });

  it('never emits responseMethod, evidenceReference, recordedByStaffUserId, client PII, or credentials from a widened source record', () => {
    const widened = {
      acceptanceId: ACCEPTANCE_ID,
      responseType: ProposalResponseType.ACCEPT,
      respondedAt,
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821, client SSN 123-45-6789',
      recordedByStaffUserId: 'staff-1',
      proposalVersionId: VERSION_ID,
      respondingClientProfile: { fullName: 'Jordan Cruz' },
      password: 'not-a-real-password',
    };

    const snapshot = sanitizeProposalResponseRecordedSnapshot(widened);

    expect(snapshot).not.toHaveProperty('responseMethod');
    expect(snapshot).not.toHaveProperty('evidenceReference');
    expect(snapshot).not.toHaveProperty('recordedByStaffUserId');
    expect(snapshot).not.toHaveProperty('proposalVersionId');
    expect(snapshot).not.toHaveProperty('respondingClientProfile');
    expect(snapshot).not.toHaveProperty('password');
    expect(JSON.stringify(snapshot)).not.toContain('Call log #4821');
    expect(JSON.stringify(snapshot)).not.toContain('123-45-6789');
    expect(JSON.stringify(snapshot)).not.toContain('Jordan Cruz');
    expect(JSON.stringify(snapshot)).not.toContain('not-a-real-password');
  });

  // Derived directly from the generated `ProposalResponseType` const object
  // (apps/web/src/generated/prisma/enums.ts), not a hand-typed string array
  // that could silently drift from the real enum if a value were ever added
  // or renamed.
  const ALL_RESPONSE_TYPES: ProposalResponseType[] = [
    ProposalResponseType.ACCEPT,
    ProposalResponseType.DECLINE,
    ProposalResponseType.REQUEST_CHANGES,
  ];

  it('handles every ProposalResponseType value exactly as submitted', () => {
    for (const responseType of ALL_RESPONSE_TYPES) {
      const snapshot = sanitizeProposalResponseRecordedSnapshot({
        acceptanceId: ACCEPTANCE_ID,
        responseType,
        respondedAt,
      });
      expect(snapshot.responseType).toBe(responseType);
    }
  });
});
