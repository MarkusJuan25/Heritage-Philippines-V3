'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

import styles from '../../payments.module.css';

type Announce = (message: string | null) => void;

const SectionFeedbackContext = createContext<Announce | null>(null);

/**
 * Success feedback for one payments section. Many actions remove their own
 * control once they succeed — a confirmed payment has no Confirm button, an
 * approved plan no Approve or Withdraw button — and `router.refresh()` then
 * unmounts that control together with any message it held. This wrapper
 * stays mounted across the refresh, so the latest success stays visible
 * at the top of the section until the next action replaces it.
 */
export function SectionFeedback({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <SectionFeedbackContext.Provider value={setMessage}>
      {message ? (
        <p role="status" className={styles.formSuccessAlert}>
          {message}
        </p>
      ) : null}
      {children}
    </SectionFeedbackContext.Provider>
  );
}

/**
 * Reports a success to the enclosing `SectionFeedback`, or to the control's
 * own local message when rendered outside one. `clear` removes the section
 * message when a new action starts, so an old success is never shown next
 * to a new error.
 */
export function useSuccessFeedback(): {
  announce: (message: string) => boolean;
  clear: () => void;
} {
  const setSectionMessage = useContext(SectionFeedbackContext);
  const announce = useCallback(
    (message: string) => {
      if (!setSectionMessage) return false;
      setSectionMessage(message);
      return true;
    },
    [setSectionMessage],
  );
  const clear = useCallback(() => setSectionMessage?.(null), [setSectionMessage]);
  return { announce, clear };
}
