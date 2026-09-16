import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { z } from 'zod';

import { getCurrentSession, getCurrentUser } from '@/lib/auth/guards';

import { ClientError } from '@/features/clients/errors';
import { getOwnClientForUser } from '@/features/clients/service';
import { ConversationError } from '@/features/conversations/errors';
import { conversationCategorySchema, messageBodySchema } from '@/features/conversations/schemas';
import {
  createConversationAsClient,
  listConversationsForClient,
  replyAsClient,
} from '@/features/conversations/service';

import { ConversationList } from './_components/ConversationList';
import type {
  ClientConversationCreateAction,
  ClientConversationCreateState,
} from './_components/CreateConversationForm';
import { CreateConversationForm } from './_components/CreateConversationForm';
import type {
  ClientConversationReplyAction,
  ClientConversationReplyState,
} from './_components/ConversationReplyForm';
import styles from '../client.module.css';

// D-051 §2/§10, per-request freshness (mirrors
// `client/my-journey/page.tsx`'s and `client/bookings/page.tsx`'s
// identical `force-dynamic`/`revalidate: 0` pair) — this page must never
// be statically prerendered or ISR-cached; the client must always see
// their own current, live Conversation state. Inherits the
// `/client/:path*` `Cache-Control: private, no-store` header from
// `next.config.ts` (unchanged).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-051 §9, Stage 4 — the exact two fields the client-facing "start a new
// conversation" Server Action ever accepts from submitted FormData:
// `category` and `body`. Composed from the already-exported field schemas
// (`features/conversations/schemas.ts`, read-only reuse — that file is not
// modified by this stage) rather than duplicating their rules. `.strict()`
// mirrors `admin/conversations/page.tsx`'s (D-051 Stage 3) and
// `client/my-journey/page.tsx`'s (D-047) identical discipline: any other
// submitted key (a forged `clientId`, author field, or timestamp) is
// rejected as `VALIDATION_ERROR`, never silently ignored or trusted.
const createConversationFormSchema = z
  .object({ category: conversationCategorySchema, body: messageBodySchema })
  .strict();

// D-051 §9/§15, Stage 4 — the exact one field a client reply Server
// Action ever accepts from submitted FormData: `body`. Never `visibility`
// — a client write is always persisted as `CLIENT_VISIBLE` by
// `replyAsClient` itself (D-051 §8/§9), so this schema does not even
// declare the field, let alone accept it.
const replyFormSchema = z.object({ body: messageBodySchema }).strict();

/**
 * D-051 §9/§10/§13/§15/§18 Stage 4 — the single `/client/support` page:
 * list, inline detail, an inline reply per conversation, and a single
 * conversation-creation form, all on one page (no `/client/support/[id]`
 * route — `Conversation` has no client-facing reference field, and D-051
 * §15 forbids `Conversation.id` from ever appearing in a URL regardless).
 *
 * Layer 3 of the four-layer authorization model: `client/layout.tsx`
 * (Layer 2) already redirects an unauthenticated request and renders its
 * own controlled panels for a non-CLIENT role or a missing ClientProfile
 * before `{children}` (this page) ever renders — this page independently
 * re-derives the same session and ownership anyway, exactly mirroring
 * `client/my-journey/page.tsx`'s and `client/bookings/page.tsx`'s own
 * "no read relies on another layer's already-performed check" discipline
 * (D-045 §2). A `ClientError`/`ConversationError` with code
 * `ROLE_NOT_PERMITTED` from this independent re-check resolves to `null`
 * (the layout owns the panel for that state); any other unexpected error
 * propagates to this route segment's `error.tsx`.
 *
 * `listConversationsForClient`'s `render` (D-051 §9's identifier-free
 * allow-list) is the only conversation data ever passed to a Client
 * Component. `serverModel` (the D-051 Stage 4 companion-model correction)
 * is read only here, inside this Server Component, to build one inline
 * `'use server'` reply action per conversation, each closure-capturing
 * only that Conversation's `id` — never a client prop, hidden form field,
 * `data-*` attribute, URL segment, or query parameter (D-051 §15).
 *
 * Every action independently re-derives a fresh, live session
 * (`getCurrentSession()`) and re-resolves the acting client via Contract A
 * (`getOwnClientForUser`) before doing anything else — never trusting the
 * render-time actor or a cached `clientId`. Both actions strip Next's own
 * injected `$ACTION_`-prefixed FormData keys, re-parse what remains with a
 * `.strict()` schema, and delegate entirely to `createConversationAsClient`/
 * `replyAsClient`, which themselves independently re-derive and re-verify
 * ownership/authorization (D-051 §7/§15) — this page never duplicates any
 * of that logic. A `ConversationError` is mapped to its own `code` (never
 * its raw `message`) for the client form to render safely; any other
 * unexpected error propagates to `error.tsx`. `revalidatePath('/client/support')`
 * runs only after a verified successful write.
 *
 * `ConversationParticipant.lastReadAt` is never read, displayed, or
 * mutated anywhere in this file (D-051 §17).
 */
export default async function ClientSupportPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  let render;
  let serverModel;
  try {
    const owned = await getOwnClientForUser(user);
    if (!owned) {
      return null;
    }

    const result = await listConversationsForClient(user, owned.clientId);
    render = result.render;
    serverModel = result.serverModel;
  } catch (error) {
    if (error instanceof ClientError && error.code === 'ROLE_NOT_PERMITTED') {
      return null;
    }
    if (error instanceof ConversationError && error.code === 'ROLE_NOT_PERMITTED') {
      return null;
    }
    throw error;
  }

  const createAction: ClientConversationCreateAction = async (
    _state: ClientConversationCreateState,
    formData: FormData,
  ): Promise<ClientConversationCreateState> => {
    'use server';
    const session = await getCurrentSession();
    if (!session) {
      return { status: 'error', code: 'UNAUTHENTICATED' };
    }

    let owned;
    try {
      owned = await getOwnClientForUser(session.user);
    } catch (error) {
      if (error instanceof ClientError && error.code === 'ROLE_NOT_PERMITTED') {
        return { status: 'error', code: 'CONVERSATION_FORBIDDEN' };
      }
      throw error;
    }
    if (!owned) {
      return { status: 'error', code: 'CONVERSATION_FORBIDDEN' };
    }

    // Next.js injects its own progressive-enhancement fields
    // (`$ACTION_ID_*`, `$ACTION_REF_*`, `$ACTION_1:*`, ...) into a Server
    // Action's submitted FormData. Strip ONLY those documented
    // `$ACTION_`-prefixed keys; `category` and `body` stay the only
    // client-controlled fields, and `createConversationFormSchema` keeps
    // `.strict()`, so any other unexpected key is still rejected.
    const submittedFields = Object.fromEntries(
      [...formData.entries()].filter(([key]) => !key.startsWith('$ACTION_')),
    );
    const parsed = createConversationFormSchema.safeParse(submittedFields);
    if (!parsed.success) {
      return { status: 'error', code: 'VALIDATION_ERROR' };
    }

    try {
      await createConversationAsClient(session.user, owned.clientId, {
        category: parsed.data.category,
        body: parsed.data.body,
      });
      revalidatePath('/client/support');
      return { status: 'success' };
    } catch (error) {
      if (error instanceof ConversationError) {
        return { status: 'error', code: error.code };
      }
      throw error;
    }
  };

  const replyActions: ClientConversationReplyAction[] = serverModel.map((card) => {
    const respond: ClientConversationReplyAction = async (
      _state: ClientConversationReplyState,
      formData: FormData,
    ): Promise<ClientConversationReplyState> => {
      'use server';
      const session = await getCurrentSession();
      if (!session) {
        return { status: 'error', code: 'UNAUTHENTICATED' };
      }

      let owned;
      try {
        owned = await getOwnClientForUser(session.user);
      } catch (error) {
        if (error instanceof ClientError && error.code === 'ROLE_NOT_PERMITTED') {
          return { status: 'error', code: 'CONVERSATION_FORBIDDEN' };
        }
        throw error;
      }
      if (!owned) {
        return { status: 'error', code: 'CONVERSATION_FORBIDDEN' };
      }

      const submittedFields = Object.fromEntries(
        [...formData.entries()].filter(([key]) => !key.startsWith('$ACTION_')),
      );
      const parsed = replyFormSchema.safeParse(submittedFields);
      if (!parsed.success) {
        return { status: 'error', code: 'VALIDATION_ERROR' };
      }

      try {
        await replyAsClient(session.user, owned.clientId, {
          conversationId: card.id,
          body: parsed.data.body,
        });
        revalidatePath('/client/support');
        return { status: 'success' };
      } catch (error) {
        if (error instanceof ConversationError) {
          return { status: 'error', code: error.code };
        }
        throw error;
      }
    };
    return respond;
  });

  return (
    <div className={styles.overview}>
      <h1 className={styles.pageHeading}>Support & Messages</h1>
      <CreateConversationForm action={createAction} />
      <ConversationList conversations={render} replyActions={replyActions} />
    </div>
  );
}
