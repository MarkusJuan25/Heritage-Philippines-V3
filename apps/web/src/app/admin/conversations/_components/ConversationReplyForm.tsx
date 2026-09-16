'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { ConversationErrorCode } from '@/features/conversations/errors';
import { MESSAGE_BODY_MAX_LENGTH } from '@/features/conversations/schemas';
import type { MessageVisibility } from '@/generated/prisma/client';

import styles from '../conversations.module.css';

// D-051 §15/§16, Stage 3 — the staff reply control for one Conversation
// card. The bound Server Action's closure holds the target
// `Conversation.id` (D-051 §15) — this component never receives, stores,
// or renders that id in any form; it only ever holds a reference to the
// already-bound `action` function, mirroring
// `client/my-journey/_components/ProposalResponseForm.tsx`'s identical
// closure-capture discipline. The form submits only `body` and
// `visibility`; it never sends a `conversationId`, author identity, or
// timestamp.
//
// Unlike `ProposalResponseForm` (a one-time, unchangeable response per
// proposal version), a Conversation reply is a repeatable action on an
// ongoing thread — this form is never permanently replaced or disabled
// after a successful send. Instead it resets its own `body`/`visibility`
// selection back to empty on success and remains mounted for the next
// reply, while `revalidatePath('/admin/conversations')` (run inside the
// action itself) refreshes the rendered thread with the newly posted
// message.

export type ConversationReplyState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; code: ConversationErrorCode | 'UNAUTHENTICATED' };

export type ConversationReplyAction = (
  state: ConversationReplyState,
  formData: FormData,
) => Promise<ConversationReplyState>;

const VISIBILITY_OPTIONS: ReadonlyArray<{ value: MessageVisibility; label: string }> = [
  { value: 'CLIENT_VISIBLE', label: 'Client-visible' },
  { value: 'INTERNAL_NOTE', label: 'Internal note' },
];

// Client-safe, non-revealing copy for each controlled outcome — never a
// raw thrown-error message rendered verbatim, mirroring
// `ProposalResponseForm.tsx`'s identical `ERROR_MESSAGES` discipline. None
// of these distinguishes "conversation does not exist" from "no longer
// authorized" from any other denial reason (D-051 §15's own
// non-enumerating requirement, carried through to this UI layer).
const ERROR_MESSAGES: Record<ConversationErrorCode | 'UNAUTHENTICATED', string> = {
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  ROLE_NOT_PERMITTED: 'You do not have permission to reply to this conversation.',
  CONVERSATION_FORBIDDEN:
    'This conversation is no longer accessible. Refresh the page to see the latest.',
  VALIDATION_ERROR: 'Please enter a message and choose a visibility before sending.',
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

export function ConversationReplyForm({ action }: { action: ConversationReplyAction }) {
  const [state, formAction] = useActionState<ConversationReplyState, FormData>(action, {
    status: 'idle',
  });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<MessageVisibility | ''>('');
  const legendId = useId();
  const resultRef = useRef<HTMLParagraphElement>(null);

  // React's own documented "adjusting state when a value changes during
  // render" pattern (react.dev's "You Might Not Need an Effect") — calling
  // setState directly in the render body, guarded by comparing against the
  // last `state` this render has already handled, rather than inside a
  // `useEffect`. This clears the entered message and selection exactly
  // once per newly successful reply. A Conversation reply is repeatable
  // (unlike `ProposalResponseForm`'s one-time response), so this form must
  // reset and remain usable rather than being permanently replaced.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === 'success') {
      setBody('');
      setVisibility('');
    }
  }

  // Imperative focus-management is a genuine effect (synchronizing with
  // the DOM, not React state) — this never calls setState.
  useEffect(() => {
    if (state.status === 'success' || state.status === 'error') {
      resultRef.current?.focus();
    }
  }, [state]);

  const blocked = body.trim().length === 0 || visibility === '';

  return (
    // `key={state.status}`: mirrors ProposalResponseForm.tsx's identical
    // remount-on-status-change technique — React 19 natively resets a
    // `<form action>`'s uncontrolled DOM state after the action runs;
    // remounting reapplies this component's own controlled `body`/
    // `visibility` state (preserved on error, cleared on success above)
    // onto fresh DOM nodes.
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

        <div className={styles.visibilityOptions} role="radiogroup" aria-label="Visibility">
          {VISIBILITY_OPTIONS.map((option) => (
            <label key={option.value} className={styles.option}>
              <input
                type="radio"
                name="visibility"
                value={option.value}
                checked={visibility === option.value}
                onChange={() => setVisibility(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
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
