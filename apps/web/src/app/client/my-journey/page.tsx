import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getCurrentSession, getCurrentUser } from '@/lib/auth/guards';
import { ClientError } from '@/features/clients/errors';
import { getOwnClientForUser } from '@/features/clients/service';
import { ProposalError } from '@/features/proposals/errors';
import { parseProposalReviewPageParam } from '@/features/proposals/schemas';
import {
  clientProposalResponseCodeFor,
  clientProposalResponseSchema,
  getClientProposalReviewPage,
  submitClientProposalResponse,
  type ClientProposalResponseAction,
  type ClientProposalReviewRender,
} from '@/features/proposals/service';

import { ProposalReviewList } from './_components/ProposalReviewList';
import styles from '../client.module.css';

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// D-047 §2/§11 — recomputed per request from the caller's own session;
// never statically prerendered, ISR-cached, or full-route-cached. Inherits
// the `/client/:path*` `Cache-Control: private, no-store` /
// `Referrer-Policy: no-referrer` headers from next.config.ts (unchanged).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-047 §2/§6, Layer 3 of the four-layer authorization model. An async
// Server Component that also defines, for each rendered card, an inline
// `'use server'` response action whose closure captures ONLY that card's
// internal `ProposalVersion.id` (from the server-only companion model —
// never a client prop, hidden input, `data-*`, URL, or rendered HTML). The
// form submits only `responseType` and the acknowledgement checkbox. Next
// serializes the captured id into an ENCRYPTED Server Action reference
// (transport protection, not authorization), so the action is treated as
// directly invocable: on every call it re-derives the verified session
// (`getCurrentSession()`), drops only Next's own injected `$ACTION_`*
// framework fields, re-parses what remains with the `.strict()` schema
// (so any other unexpected field is still rejected), and delegates to
// `submitClientProposalResponse`, which itself
// re-derives role + ownership + eligibility inside one SERIALIZABLE
// transaction (§7). The action returns only an identifier-free
// `ClientProposalResponseState`; a `ProposalError` maps to a controlled
// code, and any other error propagates to the segment `error.tsx`.
//
// It reads exactly one optional URL query, `page=N` (no database
// identifier, §5), through `parseProposalReviewPageParam`. The owned
// `clientId` is resolved from the session identity alone via Contract A;
// the read is re-checked with `canAccessClient` inside the proposals
// service. D-045 catch: Contract A `null` (no ClientProfile) and a
// `ROLE_NOT_PERMITTED` from Contract A (`ClientError`) or the read service
// (`ProposalError`) resolve to `null` (the layout owns the panel); every
// other value rethrows to `error.tsx`. `redirect('/login')` is raised
// before the try; the pagination `redirect('/client/my-journey')` is a Next
// navigation signal the catch re-raises (it is neither error class). JSX is
// constructed only after the try/catch.
//
// The rendered DTO is the identifier-free `ClientProposalReviewRender`
// (§4): no `Proposal` / `ProposalVersion` / `ProposalAcceptance` id,
// `ClientProfile.id`, `clientId`, or session value is present in it.
export default async function ClientMyJourneyPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const { page: rawPage } = await searchParams;
  const page = parseProposalReviewPageParam(rawPage);

  let render: ClientProposalReviewRender | null = null;
  let responseActions: ClientProposalResponseAction[] = [];
  try {
    const owned = await getOwnClientForUser(user);
    if (!owned) {
      return null;
    }

    const result = await getClientProposalReviewPage(user, owned.clientId, page);

    if (result.kind === 'redirect') {
      redirect('/client/my-journey');
    }

    render = result.render;
    responseActions = result.serverModel.cards.map((serverCard) => {
      const respond: ClientProposalResponseAction = async (_state, formData) => {
        'use server';
        const session = await getCurrentSession();
        if (!session) {
          return { status: 'error', code: 'FORBIDDEN' };
        }

        // Next.js injects its own progressive-enhancement fields
        // (`$ACTION_ID_*`, `$ACTION_REF_*`, `$ACTION_1:*`, ...) into a Server
        // Action's submitted FormData. Strip ONLY those documented
        // `$ACTION_`-prefixed keys; `responseType` and `acknowledgement` stay
        // the only client-controlled fields, and `clientProposalResponseSchema`
        // keeps `.strict()`, so a forged `proposalVersionId` / `clientId` /
        // `respondedAt` — or a `$ACTION`-without-underscore key — is still
        // rejected as VALIDATION_ERROR.
        const submittedFields = Object.fromEntries(
          [...formData.entries()].filter(([key]) => !key.startsWith('$ACTION_')),
        );
        const parsed = clientProposalResponseSchema.safeParse(submittedFields);
        if (!parsed.success) {
          return { status: 'error', code: 'VALIDATION_ERROR' };
        }

        try {
          const outcome = await submitClientProposalResponse({
            actor: session.user,
            sessionId: session.sessionId,
            proposalVersionId: serverCard.proposalVersionId,
            responseType: parsed.data.responseType,
            acknowledged: parsed.data.acknowledgement === 'on',
          });
          revalidatePath('/client/my-journey');
          return { status: 'success', responseType: outcome.responseType };
        } catch (error) {
          if (error instanceof ProposalError) {
            return { status: 'error', code: clientProposalResponseCodeFor(error) };
          }
          throw error;
        }
      };
      return respond;
    });
  } catch (error) {
    if (
      (error instanceof ClientError || error instanceof ProposalError) &&
      error.code === 'ROLE_NOT_PERMITTED'
    ) {
      return null;
    }
    throw error;
  }

  if (render === null) {
    return null;
  }

  return (
    <div className={styles.overview}>
      <h1 className={styles.pageHeading}>My Journey</h1>
      <ProposalReviewList render={render} responseActions={responseActions} />
    </div>
  );
}
