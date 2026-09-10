'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type {
  ClientProposalResponseAction,
  ClientProposalResponseCode,
} from '@/features/proposals/service';

import styles from './ProposalResponseForm.module.css';

// D-047 §6/§9/§12 — the response control for an awaiting proposal-review
// card. A real <form> bound to the card's inline Server Action (whose
// closure holds the target ProposalVersion.id — never a hidden input, a
// data-* attribute, or any client prop here). The form submits ONLY
// `responseType` (radio) and `acknowledgement` (checkbox); it never sends a
// timestamp or any identifier. The submit control is disabled until exactly
// one response type and the acknowledgement are both set — and both are
// re-validated server-side (§9). On error the form is kept with the
// selections intact and a client-safe `role="alert"` message; on success it
// is replaced by a `role="status"` summary and the route revalidates so the
// card re-renders in its permanent responded state. Focus moves to the
// result region on completion.

const RESPONSE_OPTIONS = [
  { value: 'ACCEPT', label: 'Accept' },
  { value: 'DECLINE', label: 'Decline' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
] as const;

// Client-safe, identifier-free copy for each controlled outcome (§6/§11) —
// never a Prisma message, identifier, staff field, or session value.
const ERROR_MESSAGES: Record<ClientProposalResponseCode, string> = {
  FORBIDDEN:
    'We could not record your response. Please contact your Heritage Philippines travel consultant.',
  VALIDATION_ERROR:
    'Please choose a response and confirm that you understand it is final for this version.',
  PROPOSAL_RESPONSE_ALREADY_RECORDED:
    'A response has already been recorded for this proposal version. Refresh the page to see the latest.',
  PROPOSAL_VERSION_NOT_CURRENT:
    'This proposal version is no longer the current one. Refresh the page to see the latest.',
  PROPOSAL_VERSION_SUPERSEDED:
    'Your travel consultant has published a newer version of this proposal. Refresh the page to see the latest.',
  PROPOSAL_CONFLICT:
    'We could not record your response because of a conflicting update. Please try again.',
};

function PendingNotice() {
  const { pending } = useFormStatus();
  if (!pending) {
    return null;
  }
  return (
    <p role="status" className={styles.pending}>
      Submitting your response…
    </p>
  );
}

function SubmitButton({ blocked }: { blocked: boolean }) {
  const { pending } = useFormStatus();
  const disabled = blocked || pending;
  return (
    <button type="submit" className={styles.submit} disabled={disabled} aria-disabled={disabled}>
      {pending ? 'Submitting…' : 'Submit response'}
    </button>
  );
}

export function ProposalResponseForm({
  action,
  versionNumber,
}: {
  action: ClientProposalResponseAction;
  versionNumber: number;
}) {
  const [state, formAction] = useActionState<
    Awaited<ReturnType<ClientProposalResponseAction>>,
    FormData
  >(action, { status: 'idle' });
  const [responseType, setResponseType] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const legendId = useId();
  const ackId = useId();
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.status === 'success' || state.status === 'error') {
      resultRef.current?.focus();
    }
  }, [state]);

  if (state.status === 'success') {
    return (
      <p ref={resultRef} tabIndex={-1} role="status" className={styles.result}>
        Your response has been recorded. This response can&apos;t be changed for this version.
      </p>
    );
  }

  const blocked = responseType === '' || !acknowledged;

  return (
    // `key` on the form: React 19 natively resets a `<form action>` after the
    // action runs. Our radio/checkbox are controlled by state that IS
    // preserved (`responseType` / `acknowledged` never reset on error), so
    // remounting the form subtree when `state.status` changes re-applies that
    // preserved selection to the DOM inputs — the form is never cleared on a
    // rejected submit (D-047 §9).
    <form key={state.status} action={formAction} className={styles.form} aria-labelledby={legendId}>
      <fieldset className={styles.fieldset}>
        <legend id={legendId} className={styles.legend}>
          How would you like to respond to Version {versionNumber}?
        </legend>
        {RESPONSE_OPTIONS.map((option) => (
          <label key={option.value} className={styles.option}>
            <input
              type="radio"
              name="responseType"
              value={option.value}
              checked={responseType === option.value}
              onChange={() => setResponseType(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <label className={styles.acknowledgement} htmlFor={ackId}>
        <input
          id={ackId}
          type="checkbox"
          name="acknowledgement"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I understand this response is final for this proposal version.</span>
      </label>

      {state.status === 'error' ? (
        <p ref={resultRef} tabIndex={-1} role="alert" className={styles.error}>
          {ERROR_MESSAGES[state.code]}
        </p>
      ) : null}

      <PendingNotice />
      <SubmitButton blocked={blocked} />
    </form>
  );
}
