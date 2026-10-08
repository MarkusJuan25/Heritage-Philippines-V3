// D-065 §6 — verified context closure for the finance export browser
// check. Typed structurally and free of any Playwright import, so the
// failure paths can be unit-tested without a browser
// (src/e2e-support/context-closure.test.ts).

export type ClosablePage = { close(): Promise<unknown> };
export type ClosableContext = { pages(): ClosablePage[]; close(): Promise<unknown> };
export type ContextOwner<Context extends ClosableContext> = { contexts(): Context[] };

/**
 * Asks every page and then every context to close, for every targeted
 * context: the ones passed in `known` and every one the browser still
 * lists, whichever spec file created it (D-065 §4). A failure to close one
 * does not stop the attempt to close the others (§6(a)), and the text of a
 * close error is never reported or thrown (§5).
 *
 * Returns whether closure was established: `true` only when the browser
 * lists no context afterwards. A context with no open page that is still
 * listed is not closed, and a list that cannot be read establishes nothing
 * (§6(b)).
 *
 * Never throws, so the database cleanup that follows it always runs
 * (§6(e)).
 */
export async function closeContextsAndVerify<Context extends ClosableContext>(
  browser: ContextOwner<Context>,
  known: readonly Context[],
): Promise<boolean> {
  let listed: Context[] = [];
  try {
    listed = browser.contexts();
  } catch {
    // The verification below reads the list again and reports the outcome.
  }

  for (const context of new Set<Context>([...known, ...listed])) {
    let pages: ClosablePage[] = [];
    try {
      pages = context.pages();
    } catch {
      // Nothing to close page by page; the context is still asked to close.
    }
    for (const page of pages) {
      try {
        await page.close();
      } catch {
        // Discarded: the outcome is established from the final state.
      }
    }
    try {
      await context.close();
    } catch {
      // Discarded: the outcome is established from the final state.
    }
  }

  try {
    return browser.contexts().length === 0;
  } catch {
    return false;
  }
}
