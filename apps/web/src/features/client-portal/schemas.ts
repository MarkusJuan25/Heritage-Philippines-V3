import type { NonDraftBookingStatus } from '@/features/bookings/service';

import type { ProgressLineState, ProposalLineState } from './travel-status';

// Output DTO types for the Client Home / Overview composition
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §§3, 7, 8). This feature is
// composition-only and accepts no request input, so there is no request
// schema here — only the shape `getClientOverview` returns and the Server
// Component (Stage 6c) renders.
//
// D-040 §8's id-free guarantee is structural: no member of `ClientOverview`
// or any nested type carries the resolved `clientId`, the `ClientProfile.id`,
// the caller's `userId`, or any `Proposal` / `ProposalVersion` / `Booking` /
// `PortalInvitation` database id. `bookingReference` (a client-facing
// reference, not a database id) is the one booking identifier present.

export type ClientOverviewIdentity = {
  fullName: string;
  email: string | null;
  phone: string | null;
};

export type ClientOverviewProposalPreviewItem = {
  versionNumber: number;
  statusLabel: string;
};

export type ClientOverviewProposals = {
  currentVisibleTotal: number;
  preview: ClientOverviewProposalPreviewItem[];
};

export type ClientOverviewBookingPreviewItem = {
  bookingReference: string;
  statusLabel: string;
  travelStartDate: Date | null;
  travelEndDate: Date | null;
  destination: string | null;
  tourPackageName: string | null;
};

export type ClientOverviewBookings = {
  total: number;
  byStatus: Record<NonDraftBookingStatus, number>;
  preview: ClientOverviewBookingPreviewItem[];
};

export type ClientOverviewProposalLine = {
  state: ProposalLineState;
  sentence: string;
};

export type ClientOverviewProgressLine = {
  state: ProgressLineState;
  sentence: string;
};

export type ClientOverviewTravelStatus = {
  proposalLine: ClientOverviewProposalLine | null;
  progressLine: ClientOverviewProgressLine;
};

export type ClientOverviewConsultant = { name: string } | null;

export type ClientOverview = {
  identity: ClientOverviewIdentity;
  proposals: ClientOverviewProposals;
  bookings: ClientOverviewBookings;
  travelStatus: ClientOverviewTravelStatus;
  consultant: ClientOverviewConsultant;
};
