import type { AuthenticatedUser } from '@/lib/auth/guards';

import { getActiveConsultantNameForClient } from '@/features/assignments/service';
import {
  NON_DRAFT_BOOKING_STATUSES,
  getClientBookingFacts,
  getClientBookingPreview,
} from '@/features/bookings/service';
import { getOwnClientForUser } from '@/features/clients/service';
import { getClientProposalFacts, getClientProposalPreview } from '@/features/proposals/service';

import { ClientPortalError } from './errors';
import type { ClientOverview, ClientOverviewTravelStatus } from './schemas';
import { deriveTravelStatus, progressLineSentence, proposalLineSentence } from './travel-status';

// The Client Home / Overview composition (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-040). This module is composition-only, per D-040 §3: it has no
// repository.ts, imports no other feature's repository.ts, never touches
// `prisma` or any Prisma delegate, opens no transaction, writes nothing,
// exposes no API route, and performs no mutation. It calls the six
// owning-feature CLIENT-safe read contracts (A-F) and the pure
// `deriveTravelStatus` algorithm, then assembles the identifier-free render
// DTO the Server Component (Stage 6c) consumes.
//
// The owned `clientId` is resolved once, from `actor.id` only (Contract A).
// It is never read from a request path, query, body, or component prop, and
// is passed to Contracts B-F verbatim — each of which independently
// re-checks `canAccessClient(actor, clientId)` before its read (D-040 §2).

const FORBIDDEN_MESSAGE = 'This area is for Heritage Philippines client accounts.';
const PROFILE_NOT_SET_UP_MESSAGE =
  "Your client account isn't fully set up yet. Please contact your Heritage Philippines travel consultant.";

/**
 * Assembles the complete Client Home / Overview render DTO for the
 * authenticated CLIENT-portal user.
 *
 * - A non-CLIENT actor is rejected with `ClientPortalError('FORBIDDEN')`
 *   before any owned-client resolution or feature read (D-040 §2 layer 3).
 * - A CLIENT actor with no `ClientProfile` yet is rejected with
 *   `ClientPortalError('PROFILE_NOT_SET_UP')` (D-040 §2 layer 2, §7).
 * - Otherwise, Contracts B-F run concurrently against the server-resolved
 *   owned `clientId`; `deriveTravelStatus` (pure) turns the proposal and
 *   booking facts into the two travel-status lines; and the result is an
 *   identifier-free DTO (D-040 §8).
 */
export async function getClientOverview(actor: AuthenticatedUser): Promise<ClientOverview> {
  if (actor.role !== 'CLIENT') {
    throw new ClientPortalError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }

  const owned = await getOwnClientForUser(actor);
  if (!owned) {
    throw new ClientPortalError('PROFILE_NOT_SET_UP', PROFILE_NOT_SET_UP_MESSAGE);
  }

  const { clientId } = owned;

  const [proposalFacts, proposalPreview, bookingFacts, bookingPreview, consultant] =
    await Promise.all([
      getClientProposalFacts(actor, clientId),
      getClientProposalPreview(actor, clientId),
      getClientBookingFacts(actor, clientId),
      getClientBookingPreview(actor, clientId),
      getActiveConsultantNameForClient(actor, clientId),
    ]);

  const derived = deriveTravelStatus(proposalFacts, bookingFacts);

  const bookingTotal = NON_DRAFT_BOOKING_STATUSES.reduce(
    (sum, status) => sum + bookingFacts.byStatus[status],
    0,
  );

  return {
    identity: {
      fullName: owned.fullName,
      email: owned.email,
      phone: owned.phone,
    },
    proposals: {
      currentVisibleTotal: proposalFacts.currentVisibleTotal,
      preview: proposalPreview.items,
    },
    bookings: {
      total: bookingTotal,
      byStatus: bookingFacts.byStatus,
      preview: bookingPreview.items,
    },
    travelStatus: {
      proposalLine: derived.proposalLine
        ? {
            state: derived.proposalLine,
            sentence: proposalLineSentence(derived.proposalLine, proposalFacts),
          }
        : null,
      progressLine: {
        state: derived.progressLine,
        sentence: progressLineSentence(derived.progressLine),
      },
    },
    consultant: consultant ? { name: consultant.name } : null,
  };
}

/**
 * The Client My Journey progress composite (docs/HERITAGE_V3_DECISIONS_LOG.md
 * D-050 §§2, 3, 4). Reuses the existing D-040 §6 `deriveTravelStatus`
 * derivation and its two already-independently-self-authorizing Contracts B
 * (`getClientProposalFacts`) and D (`getClientBookingFacts`) — never a new
 * derivation, never a new field. Composition-only, exactly like
 * `getClientOverview` above: no repository.ts, no Prisma import, no
 * mutation, no consultant/identity/preview reads (§3 — this route's own
 * heading and paginated proposal list already make those redundant).
 *
 * - A non-CLIENT actor is rejected with `ClientPortalError('FORBIDDEN')`
 *   before either reused read starts (D-050 §2's defense-in-depth gate,
 *   mirroring `getClientOverview`'s identical gate above) — never a
 *   `ProposalError` or a `BookingError`.
 * - `getClientProposalFacts` and `getClientBookingFacts` retain their own
 *   independent role and ownership checks completely unchanged: each still
 *   calls its own private `assertClientPortalAccess(actor, clientId)` before
 *   its own repository query. Neither call's outcome is assumed from the
 *   other's, or from this function's own top-level gate having passed
 *   (D-050 §2/§7) — an ownership rejection from whichever reused contract
 *   runs first (`ProposalError('CLIENT_FORBIDDEN')` or
 *   `BookingError('BOOKING_FORBIDDEN')`) propagates unconverted and
 *   unsuppressed.
 * - `clientId` is always the caller's own server-resolved owned id (D-050
 *   §2) — never re-resolved here, and never read from a request path,
 *   query, or component prop.
 */
export async function getClientJourneyProgress(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<ClientOverviewTravelStatus> {
  if (actor.role !== 'CLIENT') {
    throw new ClientPortalError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }

  const [proposalFacts, bookingFacts] = await Promise.all([
    getClientProposalFacts(actor, clientId),
    getClientBookingFacts(actor, clientId),
  ]);

  const derived = deriveTravelStatus(proposalFacts, bookingFacts);

  return {
    proposalLine: derived.proposalLine
      ? {
          state: derived.proposalLine,
          sentence: proposalLineSentence(derived.proposalLine, proposalFacts),
        }
      : null,
    progressLine: {
      state: derived.progressLine,
      sentence: progressLineSentence(derived.progressLine),
    },
  };
}
