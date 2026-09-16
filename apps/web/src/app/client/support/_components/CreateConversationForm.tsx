'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { ConversationErrorCode } from '@/features/conversations/errors';
import { MESSAGE_BODY_MAX_LENGTH } from '@/features/conversations/constants';
import type { ConversationCategory } from '@/generated/prisma/client';

import styles from '../support.module.css';

// D-051 §2/§9, Stage 4 — the sole conversation-creation entry point on
// `/client/support`. Submits exactly `category` and `body` — never
// `visibility`, an author identity, a timestamp, a participant, or a
// related-record id (D-051 §9's two-operation write path: creation and
// reply are never conflated). `ConversationCategory` is imported
// `import type` only (erased at compile time, per the D-051 Stage 3 CI
// correction's own established discipline) — `CATEGORY_OPTIONS` below is a
// plain array of string literals, never a runtime reference to the
// Prisma-generated enum object, so this component never pulls
// `@/generated/prisma/client`'s runtime module into the browser bundle.
//
// Like `ConversationReplyForm`, this is never permanently replaced after
// success — a client may start more than one conversation — it resets its
// own `category`/`body` back to empty and remains usable, while
// `revalidatePath('/client/support')` (run inside the action) refreshes
// the list below with the newly created conversation.

export type ClientConversationCreateState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; code: ConversationErrorCode | 'UNAUTHENTICATED' };

export type ClientConversationCreateAction = (
  state: ClientConversationCreateState,
  formData: FormData,
) => Promise<ClientConversationCreateState>;

// The complete, unmodified eight-value `ConversationCategory` enum (D-051
// §4), reused here as plain client-safe string literals with their own
// display labels — never the runtime Prisma enum object.
const CATEGORY_OPTIONS: ReadonlyArray<{ value: ConversationCategory; label: string }> = [
  { value: 'GENERAL_INQUIRY', label: 'General Inquiry' },
  { value: 'PROPOSAL_ROS', label: 'Proposal / ROS' },
  { value: 'BOOKING', label: 'Booking' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'DOCUMENTS', label: 'Documents' },
  { value: 'VISA', label: 'Visa' },
  { value: 'TRAVEL_PREPARATION', label: 'Travel Preparation' },
  { value: 'TECHNICAL_SUPPORT', label: 'Technical Support' },
];

const ERROR_MESSAGES: Record<ConversationErrorCode | 'UNAUTHENTICATED', string> = {
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  ROLE_NOT_PERMITTED: 'You do not have permission to start a new conversation.',
  CONVERSATION_FORBIDDEN: 'We could not start this conversation. Please try again.',
  VALIDATION_ERROR: 'Please choose a category and enter a message before sending.',
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
      {pending ? 'Starting…' : 'Start conversation'}
    </button>
  );
}

export function CreateConversationForm({ action }: { action: ClientConversationCreateAction }) {
  const [state, formAction] = useActionState<ClientConversationCreateState, FormData>(action, {
    status: 'idle',
  });
  const [category, setCategory] = useState<ConversationCategory | ''>('');
  const [body, setBody] = useState('');
  const legendId = useId();
  const resultRef = useRef<HTMLParagraphElement>(null);

  // See ConversationReplyForm.tsx's identical comment: React's own
  // documented render-time state-adjustment pattern, not an effect.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === 'success') {
      setCategory('');
      setBody('');
    }
  }

  useEffect(() => {
    if (state.status === 'success' || state.status === 'error') {
      resultRef.current?.focus();
    }
  }, [state]);

  const blocked = category === '' || body.trim().length === 0;

  return (
    <form
      key={state.status}
      action={formAction}
      className={styles.createForm}
      aria-labelledby={legendId}
    >
      <fieldset className={styles.fieldset}>
        <legend id={legendId} className={styles.legend}>
          Start a new conversation
        </legend>

        <div className={styles.formField}>
          <label htmlFor={`${legendId}-category`}>Category</label>
          <select
            id={`${legendId}-category`}
            name="category"
            value={category}
            onChange={(event) => setCategory(event.target.value as ConversationCategory)}
            required
          >
            <option value="">Select a category…</option>
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

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
          Conversation started.
        </p>
      ) : null}

      <PendingNotice />
      <SubmitButton blocked={blocked} />
    </form>
  );
}
