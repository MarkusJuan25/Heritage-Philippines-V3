import { describe, expect, it } from 'vitest';

import { closeContextsAndVerify } from '../../e2e/support/context-closure';

// Unit tests for the finance export browser check's closure step (D-065
// §6). They live under `src` because the unit-test run collects
// `src/**/*.test.ts` only, and Playwright would load a test file under
// `e2e/` as a browser test. No browser is used: the failure paths are
// exercised with stand-ins, since no browser run could be made to fail to
// close on demand.

const SENSITIVE = 'HPB-0123456789ABCDEF0123 Juan Dela Cruz 1500.00';

type FakePage = { closed: boolean; closeCalls: number; close(): Promise<void> };
type FakeContext = {
  closeCalls: number;
  pages(): FakePage[];
  close(): Promise<void>;
};

function fakeBrowser() {
  const open: FakeContext[] = [];

  function page(options: { failsToClose?: boolean } = {}): FakePage {
    const self: FakePage = {
      closed: false,
      closeCalls: 0,
      async close() {
        self.closeCalls += 1;
        if (options.failsToClose) throw new Error(SENSITIVE);
        self.closed = true;
      },
    };
    return self;
  }

  function context(
    pages: FakePage[],
    options: { failsToClose?: boolean; pagesThrows?: boolean } = {},
  ): FakeContext {
    const self: FakeContext = {
      closeCalls: 0,
      pages() {
        if (options.pagesThrows) throw new Error(SENSITIVE);
        return pages.filter((candidate) => !candidate.closed);
      },
      async close() {
        self.closeCalls += 1;
        if (options.failsToClose) throw new Error(SENSITIVE);
        const index = open.indexOf(self);
        if (index >= 0) open.splice(index, 1);
      },
    };
    open.push(self);
    return self;
  }

  return { browser: { contexts: () => [...open] }, page, context };
}

describe('closeContextsAndVerify (D-065 §6)', () => {
  it('establishes closure when every page and context closes', async () => {
    const { browser, page, context } = fakeBrowser();
    const first = page();
    const second = page();
    const own = context([first, second]);
    const fixture = context([page()]);

    await expect(closeContextsAndVerify(browser, [own, fixture])).resolves.toBe(true);
    expect(first.closed && second.closed).toBe(true);
    expect(browser.contexts()).toEqual([]);
  });

  it('closes a context an earlier spec file left open, though it was never passed in', async () => {
    const { browser, page, context } = fakeBrowser();
    const own = context([page()]);
    const leftOpen = context([page()]);

    await expect(closeContextsAndVerify(browser, [own])).resolves.toBe(true);
    expect(leftOpen.closeCalls).toBe(1);
  });

  it('establishes closure when there is nothing left to close', async () => {
    const { browser, context } = fakeBrowser();
    const own = context([]);
    await own.close();

    await expect(closeContextsAndVerify(browser, [own])).resolves.toBe(true);
  });

  it('still attempts every other close when one page fails to close', async () => {
    const { browser, page, context } = fakeBrowser();
    const stuck = page({ failsToClose: true });
    const sibling = page();
    const own = context([stuck, sibling]);
    const other = context([page()]);

    // The context itself closed and is no longer listed, so closure is
    // established from the final state — not from the page's error.
    await expect(closeContextsAndVerify(browser, [own, other])).resolves.toBe(true);
    expect(stuck.closeCalls).toBe(1);
    expect(sibling.closed).toBe(true);
    expect(own.closeCalls).toBe(1);
    expect(other.closeCalls).toBe(1);
  });

  it('does not establish closure when a context fails to close, and still attempts the rest', async () => {
    const { browser, page, context } = fakeBrowser();
    const stuck = context([page()], { failsToClose: true });
    const after = context([page()]);

    await expect(closeContextsAndVerify(browser, [stuck, after])).resolves.toBe(false);
    expect(after.closeCalls).toBe(1);
    expect(browser.contexts()).toEqual([stuck]);
  });

  it('does not treat a context with no open page as closed while it is still listed', async () => {
    const { browser, page, context } = fakeBrowser();
    const onlyPage = page();
    const stuck = context([onlyPage], { failsToClose: true });

    await expect(closeContextsAndVerify(browser, [stuck])).resolves.toBe(false);
    expect(onlyPage.closed).toBe(true);
    expect(stuck.pages()).toEqual([]);
  });

  it('still asks a context to close when its pages cannot be listed', async () => {
    const { browser, context } = fakeBrowser();
    const opaque = context([], { pagesThrows: true });

    await expect(closeContextsAndVerify(browser, [opaque])).resolves.toBe(true);
    expect(opaque.closeCalls).toBe(1);
  });

  it('does not establish closure when the list of contexts cannot be read', async () => {
    const { page, context } = fakeBrowser();
    const own = context([page()]);
    const unreadable = {
      contexts(): FakeContext[] {
        throw new Error(SENSITIVE);
      },
    };

    await expect(closeContextsAndVerify(unreadable, [own])).resolves.toBe(false);
    // The known context was still asked to close.
    expect(own.closeCalls).toBe(1);
  });

  it('never throws and never returns anything but a boolean, so no error text can escape', async () => {
    const { browser, page, context } = fakeBrowser();
    const stuck = context([page({ failsToClose: true })], { failsToClose: true });

    const outcome: unknown = await closeContextsAndVerify(browser, [stuck]).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('HPB-');
  });
});
