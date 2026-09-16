import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { z } from 'zod';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentSession, getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { ConversationError } from '@/features/conversations/errors';
import { messageBodySchema, messageVisibilitySchema } from '@/features/conversations/schemas';
import { listConversationsForStaff, replyAsStaff } from '@/features/conversations/service';

import type { ConversationCardView } from './_components/ConversationCard';
import { ConversationList } from './_components/ConversationList';
import type {
  ConversationReplyAction,
  ConversationReplyState,
} from './_components/ConversationReplyForm';
import styles from './conversations.module.css';

// D-051 §5/§6, Decision 3 (Stage 3 authorization) — the four roles
// `assertConversationStaffActor` (features/conversations/service.ts)
// itself recognizes. This page-level gate is a UI convenience only, not
// an independent authorization decision: `listConversationsForStaff` and
// `replyAsStaff` remain the sole authority for what each of these roles
// can actually see or do (FINANCE_ACCOUNTING/VISA_DOCUMENTATION are
// authorized here but, absent the deferred participant-management
// capability, will always see a correctly-empty list — D-051 §5's own
// "genuine, narrow scope limit... not an oversight"). SYSTEM_ADMINISTRATOR
// and CLIENT are rejected below, exactly as the service layer itself
// would reject them.
const CONVERSATION_STAFF_ROLES: readonly AppRole[] = [
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
];

// D-051 §16, Stage 3 — the exact two fields a staff reply Server Action
// ever accepts from submitted FormData: `body` and `visibility`. Composed
// locally from Stage 2's already-exported field schemas
// (`features/conversations/schemas.ts`, read-only reuse — that file is
// not modified by this stage) rather than duplicating their rules.
// `.strict()` mirrors `client/my-journey/page.tsx`'s
// `clientProposalResponseSchema` discipline exactly: any other submitted
// key (a forged `conversationId`, `clientId`, or author field) is
// rejected as `VALIDATION_ERROR`, never silently ignored or trusted.
const conversationReplyFormSchema = z
  .object({ body: messageBodySchema, visibility: messageVisibilitySchema })
  .strict();

// D-051 §2/§3, per-request freshness (mirrors
// `client/my-journey/page.tsx`'s identical `force-dynamic`/`revalidate: 0`
// pair) — this page must never be statically prerendered or ISR-cached;
// every staff member must see the current, live Conversation state.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * D-051 §10/§13/§15/§18 Stage 3 — the single `/admin/conversations` page:
 * list, inline detail, and inline reply together, with no
 * `/admin/conversations/[id]` route (the reviewed Stage 3 route-shape
 * decision). An async Server Component that also defines, for each
 * rendered Conversation, an inline `'use server'` reply action whose
 * closure captures ONLY that Conversation's server-only `id` (from
 * `listConversationsForStaff`'s own result — never a client prop, hidden
 * form field, `data-*` attribute, URL segment, or query parameter, per
 * D-051 §15). `ConversationList`/`ConversationCard` receive a
 * `ConversationCardView` shaped to carry no `Conversation.id` or
 * `clientId` at all — the identifier lives only in this closure.
 *
 * Every action independently re-derives a fresh, live session
 * (`getCurrentSession()`) before doing anything else — never trusting the
 * render-time actor — strips Next's own injected `$ACTION_`-prefixed
 * FormData keys, re-parses what remains with `conversationReplyFormSchema`
 * (`.strict()`), and delegates to `replyAsStaff`, which itself
 * independently re-derives the Conversation's actual owning Client and
 * re-verifies role/assignment/participant authorization (D-051 §5/§6/§15)
 * — this page never duplicates any of that logic. A `ConversationError` is
 * mapped to its own `code` (never its raw `message`) for the client form
 * to render safely; any other unexpected error propagates to this route
 * segment's `error.tsx`, mirroring `admin/proposals/page.tsx`'s identical
 * "not caught here" discipline for `listConversationsForStaff` itself.
 * `revalidatePath('/admin/conversations')` runs only after a verified
 * successful reply.
 *
 * `ConversationParticipant.lastReadAt` is never read, displayed, or
 * mutated anywhere in this file (D-051 §17).
 */
export default async function AdminConversationsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, CONVERSATION_STAFF_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>
          Only Admin/Manager, Travel Consultant, Finance/Accounting, and Visa Documentation staff
          can access Conversations.
        </p>
      </div>
    );
  }

  const rows = await listConversationsForStaff(user);

  const conversations: ConversationCardView[] = rows.map((row) => ({
    category: row.category,
    clientFullName: row.clientFullName,
    createdAt: row.createdAt,
    messages: row.messages,
  }));

  const replyActions: ConversationReplyAction[] = rows.map((row) => {
    const respond: ConversationReplyAction = async (
      _state: ConversationReplyState,
      formData: FormData,
    ): Promise<ConversationReplyState> => {
      'use server';
      const session = await getCurrentSession();
      if (!session) {
        return { status: 'error', code: 'UNAUTHENTICATED' };
      }

      // Next.js injects its own progressive-enhancement fields
      // (`$ACTION_ID_*`, `$ACTION_REF_*`, `$ACTION_1:*`, ...) into a Server
      // Action's submitted FormData. Strip ONLY those documented
      // `$ACTION_`-prefixed keys; `body` and `visibility` stay the only
      // client-controlled fields, and `conversationReplyFormSchema` keeps
      // `.strict()`, so a forged `conversationId` or any other unexpected
      // key is still rejected as VALIDATION_ERROR.
      const submittedFields = Object.fromEntries(
        [...formData.entries()].filter(([key]) => !key.startsWith('$ACTION_')),
      );
      const parsed = conversationReplyFormSchema.safeParse(submittedFields);
      if (!parsed.success) {
        return { status: 'error', code: 'VALIDATION_ERROR' };
      }

      try {
        await replyAsStaff(session.user, {
          conversationId: row.id,
          body: parsed.data.body,
          visibility: parsed.data.visibility,
        });
        revalidatePath('/admin/conversations');
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
    <div>
      <div className={styles.pageHeader}>
        <h1>Conversations</h1>
      </div>
      <ConversationList conversations={conversations} replyActions={replyActions} />
    </div>
  );
}
