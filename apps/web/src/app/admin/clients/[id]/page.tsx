import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { ClientError } from '@/features/clients/errors';
import { clientIdParamSchema } from '@/features/clients/schemas';
import { getClientById } from '@/features/clients/service';

import { toNullableInvitationResponse } from '@/features/invitations/http';
import { getInvitationForClient } from '@/features/invitations/service';

import styles from '../clients.module.css';
import { ClientAssignmentPanel } from './_components/ClientAssignmentPanel';
import { CreateProposalPanel } from './_components/CreateProposalPanel';
import { EditClientForm } from './_components/EditClientForm';
import { PortalInvitationPanel, type InvitationView } from './_components/PortalInvitationPanel';

// Layer 3 of the established defense-in-depth authorization pattern
// (mirrors admin/leads/[id]/page.tsx exactly): independently re-resolves
// the authenticated user (never trusting app/admin/layout.tsx's own check,
// Layer 2, and never trusting the list page either) and narrows the Client
// surface to exactly the two roles D-025 §2 authorizes.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageParams = Promise<{ id: string }>;

/**
 * Converts `toNullableInvitationResponse`'s `Date`-typed fields to ISO
 * strings before this Server Component hands the record to
 * `PortalInvitationPanel` (a Client Component) — mirrors this same file's
 * existing `client.updatedAt.toISOString()` inline-conversion precedent
 * for `EditClientForm`'s `initialUpdatedAt` prop, generalized to every
 * date-shaped invitation field, so `PortalInvitationPanel`'s own
 * `InvitationView` type describes exactly one shape regardless of whether
 * it arrived via this initial server-rendered prop or a later client-side
 * `fetch` response.
 */
function toInvitationViewProp(
  invitation: ReturnType<typeof toNullableInvitationResponse>,
): InvitationView | null {
  if (!invitation) return null;
  return {
    id: invitation.id,
    clientId: invitation.clientId,
    status: invitation.status,
    expiresAt: invitation.expiresAt ? invitation.expiresAt.toISOString() : null,
    destinationEmail: invitation.destinationEmail,
    deliveryMethod: invitation.deliveryMethod,
    deliveryState: invitation.deliveryState,
    sendOperationId: invitation.sendOperationId,
    providerMessageId: invitation.providerMessageId,
    deliveryConfirmedAt: invitation.deliveryConfirmedAt
      ? invitation.deliveryConfirmedAt.toISOString()
      : null,
    deliveryConfirmedByStaffId: invitation.deliveryConfirmedByStaffId,
    sentAt: invitation.sentAt ? invitation.sentAt.toISOString() : null,
    openedAt: invitation.openedAt ? invitation.openedAt.toISOString() : null,
    activatedAt: invitation.activatedAt ? invitation.activatedAt.toISOString() : null,
    revokedAt: invitation.revokedAt ? invitation.revokedAt.toISOString() : null,
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

/**
 * Client detail (D-025 §4/§10's `/admin/clients/[id]`). A Server Component
 * that authenticates the actor, validates the route `id` through
 * `clientIdParamSchema`, and calls the `getClientById` application service
 * directly — never a repository, never an internal fetch to `GET
 * /api/clients/[id]`. `CLIENT_NOT_FOUND`/`CLIENT_FORBIDDEN` are handled
 * explicitly inline, preserving D-025 §7/§9's anti-enumeration property
 * exactly as the service layer already shapes it (both render the identical
 * "Client not found" state) — this page never adds its own logic to
 * distinguish "missing" from "inaccessible" beyond what `getClientById`
 * itself returns. Any other error bubbles to this route segment's nearest
 * error boundary. `originatingLeads` is rendered exactly as `getClientById`
 * returns it — already ordered and actor-scoped by the service/repository
 * layer (D-025 §2/§4) — this page never re-queries, re-sorts, re-filters,
 * or reveals a hidden total. The Created/Last updated timestamps remain
 * read-only here; every editable field (fullName, email, phone, address,
 * nationality, dateOfBirth, emergencyContact, notes) is rendered and edited
 * by `EditClientForm` instead (D-025 §5/§10), seeded from this same
 * authoritative `client` read — never omitted or collapsed with another
 * field, and `normalizedEmail`/`normalizedPhone` are never passed to it
 * because `ClientDetailRecord` does not carry them in the first place
 * (D-025 §4/§9). The current assignment is rendered and, for `ADMIN_MANAGER`
 * only, managed by `ClientAssignmentPanel` (D-025 §2/§10), which receives
 * the authenticated actor's own `role` and this same `client.assignment` as
 * its authoritative starting state — a `TRAVEL_CONSULTANT` actor reaches
 * that same component but it renders read-only for them, with no
 * interactive control of any kind. For a `TRAVEL_CONSULTANT` only,
 * `CreateProposalPanel` (D-027 §8's sole first-Proposal creation entry
 * point, Stage 7C) is additionally rendered, receiving this page's own
 * already-validated `clientId` — never a Client search/picker of any kind.
 * `ADMIN_MANAGER` never sees this panel at all (D-027 §3: Admin/Manager may
 * not create a Proposal).
 *
 * `PortalInvitationPanel` (D-034 Stage 4; D-035; D-036) is rendered for
 * both allowed roles identically — unlike `ClientAssignmentPanel`,
 * blueprint §7.3 grants ADMIN_MANAGER and the assigned TRAVEL_CONSULTANT
 * equal invitation prepare/send/resend/revoke authority, so this page
 * passes no `role` prop to it. Its `initialInvitation` prop is the same
 * `getInvitationForClient` service call `GET /api/clients/[id]/invitation`
 * itself makes, passed through the same `toNullableInvitationResponse`
 * allow-list that route uses (never the raw `InvitationRecord`, which
 * still carries `tokenHash` — passing that directly to a Client Component
 * would serialize it into the page's own RSC payload).
 */
export default async function AdminClientDetailPage({ params }: { params: PageParams }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access Client management.</p>
      </div>
    );
  }

  const idResult = clientIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return (
      <div>
        <h1>Client not found</h1>
        <p>This client link is invalid.</p>
        <Link href="/admin/clients">Back to Clients</Link>
      </div>
    );
  }

  const clientId = idResult.data.id;

  let client;
  try {
    client = await getClientById(user, clientId);
  } catch (error) {
    if (
      error instanceof ClientError &&
      (error.code === 'CLIENT_NOT_FOUND' || error.code === 'CLIENT_FORBIDDEN')
    ) {
      return (
        <div>
          <h1>Client not found</h1>
          <p>This client was not found or is not accessible to you.</p>
          <Link href="/admin/clients">Back to Clients</Link>
        </div>
      );
    }
    throw error;
  }

  // D-034 Stage 4 (D-035 §2/§8, Decision 12.2): calls the same
  // `getInvitationForClient` service function `GET
  // /api/clients/[id]/invitation` itself calls — never a repository, never
  // an internal fetch to that route. `canAccessClient` (inside
  // `getInvitationForClient`) is the identical function `getClientById`
  // above already called successfully for this same actor/clientId, so
  // this call is not expected to itself throw CLIENT_NOT_FOUND/
  // CLIENT_FORBIDDEN in practice; it is deliberately left unwrapped,
  // consistent with this page's own established "any other error bubbles
  // to this route segment's nearest error boundary" discipline (see this
  // function's own doc comment above) rather than duplicating a second,
  // redundant not-found branch for an outcome that would indicate a
  // genuine race, not an expected user-facing case.
  //
  // The raw `InvitationRecord` (which still carries `tokenHash`) is never
  // passed to `PortalInvitationPanel` — a Client Component — directly:
  // Next.js serializes Client Component props into the page's own RSC
  // payload, so doing so would leak `tokenHash` into the browser exactly
  // as D-035 §8 closed at the API layer. `toNullableInvitationResponse`
  // (the same explicit allow-list the route itself uses) is applied here
  // first, reusing that one function rather than a second, parallel
  // stripping implementation.
  const invitation = toInvitationViewProp(
    toNullableInvitationResponse(await getInvitationForClient(user, clientId)),
  );

  return (
    <div>
      <Link href="/admin/clients">← Back to Clients</Link>
      <h1>{client.fullName}</h1>

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Created</dt>
          <dd>
            <time dateTime={client.createdAt.toISOString()}>
              {client.createdAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={client.updatedAt.toISOString()}>
              {client.updatedAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
      </dl>

      <ClientAssignmentPanel
        clientId={clientId}
        role={user.role}
        currentAssignment={client.assignment}
      />

      <PortalInvitationPanel clientId={clientId} initialInvitation={invitation} />

      <h2>Edit Client</h2>
      <EditClientForm
        clientId={clientId}
        initialFullName={client.fullName}
        initialEmail={client.email}
        initialPhone={client.phone}
        initialAddress={client.address}
        initialNationality={client.nationality}
        initialDateOfBirth={client.dateOfBirth}
        initialEmergencyContact={client.emergencyContact}
        initialNotes={client.notes}
        initialUpdatedAt={client.updatedAt.toISOString()}
      />

      <h2>Originating Leads</h2>
      {client.originatingLeads.length === 0 ? (
        <p>No originating leads.</p>
      ) : (
        <ul className={styles.originatingLeadsList}>
          {client.originatingLeads.map((lead) => (
            <li key={lead.id} className={styles.originatingLeadItem}>
              <div>
                <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
              </div>
              <div className={styles.originatingLeadMeta}>
                {lead.status} · {lead.source} ·{' '}
                <time dateTime={lead.createdAt.toISOString()}>
                  {lead.createdAt.toLocaleString('en-PH')}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}

      {user.role === 'TRAVEL_CONSULTANT' ? <CreateProposalPanel clientId={clientId} /> : null}
    </div>
  );
}
