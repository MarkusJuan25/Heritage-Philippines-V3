// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { PublishProposalVersionButton } from './PublishProposalVersionButton';

const VERSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CURRENT_VERSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function malformedJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

function renderButton(expectedCurrentVersionId: string | null = null) {
  return render(
    <PublishProposalVersionButton
      versionId={VERSION_ID}
      versionNumber={3}
      expectedCurrentVersionId={expectedCurrentVersionId}
    />,
  );
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  return form;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  pushMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PublishProposalVersionButton', () => {
  it('renders an accessible, version-specific button label', () => {
    renderButton();
    expect(screen.getByRole('button', { name: 'Publish Version 3' })).toBeInTheDocument();
  });

  it('submits to the exact target-version URL with the exact POST method and JSON header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/proposals/versions/${VERSION_ID}/publish`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends an explicit expectedCurrentVersionId: null when no current version was observed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton(null);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty('expectedCurrentVersionId');
    expect(body.expectedCurrentVersionId).toBeNull();
  });

  it('sends the exact non-null observed-current version id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton(CURRENT_VERSION_ID);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.expectedCurrentVersionId).toBe(CURRENT_VERSION_ID);
  });

  it('sends exactly one request-body key, never an invented field', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton(CURRENT_VERSION_ID);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(['expectedCurrentVersionId']);
  });

  it('disables the button and shows a version-specific pending label while the request is in flight', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    expect(screen.getByRole('button', { name: 'Publishing Version 3…' })).toBeDisabled();
  });

  it('prevents a second request while the first is still pending (double-submit), even bypassing the disabled button', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { container } = renderButton();

    const form = getForm(container);
    fireEvent.submit(form);
    // A second submit while the first is still pending, dispatched directly
    // on the form (bypassing the button's own `disabled` attribute) — this
    // proves the internal `submitting` guard itself, not merely the UI,
    // prevents a duplicate, non-idempotent publish request.
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(200, { version: { id: VERSION_ID } }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('validates the response version id before treating a 200 as success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: 'a-different-version-id' } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('calls router.refresh() and never router.push() on a valid 200 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows an accessible success status on a valid 200 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Version 3 published.'),
    );
  });

  it('permanently disables the button after success, preventing a redundant second publish while the refresh is pending', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Publish Version 3' })).toBeDisabled();

    const form = screen.getByRole('button', { name: 'Publish Version 3' }).closest('form');
    fireEvent.submit(form as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-enables the button after a failed submission, allowing retry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: { id: VERSION_ID } }));
    renderButton();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Publish Version 3' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Publish Version 3' })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Publish Version 3' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('shows the server message for PROPOSAL_VERSION_FORBIDDEN', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: 'PROPOSAL_VERSION_FORBIDDEN',
          message: 'Proposal version not found or not accessible.',
        },
      }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Proposal version not found or not accessible.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server message for PROPOSAL_VERSION_SUPERSEDED', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'PROPOSAL_VERSION_SUPERSEDED',
          message: 'This proposal version has already been superseded by a later revision.',
        },
      }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This proposal version has already been superseded by a later revision.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  describe('PROPOSAL_CONFLICT', () => {
    const CONFLICT_MESSAGE =
      'The current version has changed since you last loaded this proposal. Refresh and try again.';

    it('shows the controlled refresh-and-retry message and a "Refresh proposal" action', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { error: { code: 'PROPOSAL_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      renderButton();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE));
      expect(screen.getByRole('button', { name: 'Refresh proposal' })).toBeInTheDocument();
    });

    it('the "Refresh proposal" action calls router.refresh() and never issues another publish request', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, { error: { code: 'PROPOSAL_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      renderButton();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Publish Version 3' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'Refresh proposal' }));

      expect(refreshMock).toHaveBeenCalledTimes(1);
      // Still exactly one fetch call — the refresh action never resubmits
      // the publish request on its own.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows the server message for a role-forbidden/unauthenticated response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Authentication required.'),
    );
  });

  it('shows a generic message for an unexpected server failure, without leaking the raw error code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred.'),
    );
  });

  it('shows a generic error when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(200));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while publishing this version. Please check your connection and try again.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a generic error and never refreshes when the 200 response is missing version.id (incomplete success)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: {} }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a generic error and never refreshes when the 200 response names a mismatched version id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: 'wrong-version-id' } }));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('never displays raw exception text or logs anything for a network failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNRESET: raw socket failure at internal-host:5432'));
    renderButton();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Something went wrong while publishing this version. Please check your connection and try again.',
    );
    expect(alert.textContent).not.toContain('ECONNRESET');
    expect(alert.textContent).not.toContain('internal-host');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
