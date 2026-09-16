'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { ConversationErrorCode } from '@/features/conversations/errors';
import { MESSAGE_BODY_MAX_LENGTH } from '@/features/conversations/constants';

import styles from '../support.module.css';

// D-051 §9/§15, Stage 4 — the client reply control for one Conversation
// card. The bound Server Action's closure holds the target
// `Conversation.id` (D-051 §15) — this component never receives, stores,
// or renders that id in any form; it only ever holds a reference to the
// already-bound `action` function, mirroring
// `admin/conversations/_components/ConversationReplyForm.tsx`'s (D-051
// Stage 3) and `client/my-journey/_components/ProposalResponseForm.tsx`'s
// (D-047) identical closure-capture discipline. The form submits ONLY
// `body` — never `visibility` (D-051 §8/§9: a client write is always
// persisted as `CLIENT_VISIBLE` server-side by `replyAsClient` itself;
// this component never even offers the field).
//
// This is never permanently replaced or disabled after a successful send
// — a Conversation reply is a repeatable action on an ongoing thread. It
// resets its own `body` back to empty on success and remains mounted for
// the next reply, while `revalidatePath('/client/support')` (run inside
// the action itself) refreshes the rendered thread with the newly posted
// message. This component only imports type-only from
// `@/features/conversations/errors` (erased at compile time) and a plain
// numeric constant from the dependency-free
// `@/features/conversations/constants` — never the Prisma-linked
// `@/features/conversations/schemas` module and never
// `@/generated/prisma/client` at runtime.

export type ClientConversationReplyState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; code: ConversationErrorCode | 'UNAUTHENTICATED' };

export type ClientConversationReplyAction = (
  state: ClientConversationReplyState,
  formData: FormData,
) => Promise<ClientConversationReplyState>;

// Client-safe, non-revealing copy for each controlled outcome — never a
// raw thrown-error message rendered verbatim. None of these distinguishes
// "conversation does not exist" from "no longer authorized" from any
// other denial reason (D-051 §15's own non-enumerating requirement,
// carried through to this UI layer).
const ERROR_MESSAGES: Record<ConversationErrorCode | 'UNAUTHENTICATED', string> = {
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  ROLE_NOT_PERMITTED: 'You do not have permission to reply to this conversation.',
  CONVERSATION_FORBIDDEN:
    'This conversation is no longer accessible. Refresh the page to see the latest.',
  VALIDATION_ERROR: 'Please enter a message before sending.',
};

function PendingNotice() {
  const { pending } = useFormStatus();
  if (!pending) {
    return null;
  }
  return (
    <p role="status" className={styles.pending}>
      Sending…
    </p>
  );
}

function SubmitButton({ blocked }: { blocked: boolean }) {
  const { pending } = useFormStatus();
  const disabled = blocked || pending;
  return (
    <button type="submit" className={styles.submit} disabled={disabled} aria-disabled={disabled}>
      {pending ? 'Sending…' : 'Send reply'}
    </button>
  );
}

export function ConversationReplyForm({ action }: { action: ClientConversationReplyAction }) {
  const [state, formAction] = useActionState<ClientConversationReplyState, FormData>(action, {
    status: 'idle',
  });
  const [body, setBody] = useState('');
  const legendId = useId();
  const resultRef = useRef<HTMLParagraphElement>(null);

  // React's own documented "adjusting state when a value changes during
  // render" pattern (react.dev's "You Might Not Need an Effect") — calling
  // setState directly in the render body, guarded by comparing against the
  // last `state` this render has already handled, rather than inside a
  // `useEffect` (avoids the `react-hooks/set-state-in-effect` pitfall).
  // Clears the entered message exactly once per newly successful reply.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === 'success') {
      setBody('');
    }
  }

  // Imperative focus-management is a genuine effect (synchronizing with
  // the DOM, not React state) — this never calls setState.
  useEffect(() => {
    if (state.status === 'success' || state.status === 'error') {
      resultRef.current?.focus();
    }
  }, [state]);

  const blocked = body.trim().length === 0;

  return (
    // `key={state.status}`: React 19 natively resets a `<form action>`'s
    // uncontrolled DOM state after the action runs; remounting reapplies
    // this component's own controlled `body` state (preserved on error,
    // cleared on success above) onto fresh DOM nodes.
    <form
      key={state.status}
      action={formAction}
      className={styles.replyForm}
      aria-labelledby={legendId}
    >
      <fieldset className={styles.fieldset}>
        <legend id={legendId} className={styles.legend}>
          Reply
        </legend>

        <div className={styles.formField}>
          <label htmlFor={`${legendId}-body`}>Message</label>
          <textarea
            id={`${legendId}-body`}
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={MESSAGE_BODY_MAX_LENGTH}
            rows={3}
            required
          />
        </div>
      </fieldset>

      {state.status === 'error' ? (
        <p ref={resultRef} tabIndex={-1} role="alert" className={styles.formAlert}>
          {ERROR_MESSAGES[state.code]}
        </p>
      ) : null}
      {state.status === 'success' ? (
        <p ref={resultRef} tabIndex={-1} role="status" className={styles.formSuccessAlert}>
          Reply sent.
        </p>
      ) : null}

      <PendingNotice />
      <SubmitButton blocked={blocked} />
    </form>
  );
}
