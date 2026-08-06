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

import { CreateProposalRevisionPanel } from './CreateProposalRevisionPanel';

const PROPOSAL_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

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

function renderPanel() {
  return render(<CreateProposalRevisionPanel proposalId={PROPOSAL_ID} />);
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Revision content') as HTMLTextAreaElement;
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

describe('CreateProposalRevisionPanel', () => {
  it('renders an accessible, labelled form with a submit button', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Create Revision' })).toBeInTheDocument();
    expect(getTextarea()).toBeInTheDocument();
    expect(screen.getByText('Plain text only, up to 20,000 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Revision' })).toBeInTheDocument();
  });

  it('submits to the exact Proposal id in the URL, with no Proposal/Client picker of any kind', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/proposals/${PROPOSAL_ID}/versions`);
  });

  it('rejects blank content without calling fetch', async () => {
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: '' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    expect(screen.getByText('Content is required.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only content without calling fetch', async () => {
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: '   \n\t  ' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    expect(screen.getByText('Content is required.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts content at exactly the 20,000-character boundary', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'a'.repeat(20000) } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText('Content must be at most 20,000 characters.'),
    ).not.toBeInTheDocument();
  });

  it('rejects content above the 20,000-character boundary without calling fetch', async () => {
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'a'.repeat(20001) } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    expect(screen.getByText('Content must be at most 20,000 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims only leading and trailing whitespace before submitting', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: '   Hello World   ' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe('Hello World');
  });

  it('preserves internal line breaks and internal whitespace, trimming only the outer edges', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    const raw = '  Day 1: Arrival.\n\n   Day 2: City tour.  ';
    fireEvent.change(getTextarea(), { target: { value: raw } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe('Day 1: Arrival.\n\n   Day 2: City tour.');
  });

  it('submits POST /api/proposals/{proposalId}/versions with the exact URL, method, headers, and one-key JSON body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/proposals/${PROPOSAL_ID}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Revised itinerary.' }),
    });
  });

  it('never sends a field beyond content — no clientId, title, reference, versionNumber, lifecycle, price, currency, status, or assignment field', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(['content']);
  });

  it('issues exactly one request for a single valid submission', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prevents a second request while the first is still pending (double-submit), even bypassing the disabled button', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { container } = renderPanel();
    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });

    const form = getForm(container);
    fireEvent.submit(form);
    // A second submit while the first is still pending, dispatched directly
    // on the form (bypassing the button's own `disabled` attribute) — this
    // proves the internal `submitting` guard itself, not merely the UI,
    // prevents a duplicate, non-idempotent POST request.
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('disables the submit button and textarea, showing a pending label, while the request is in flight', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(getTextarea()).toBeDisabled();
  });

  it('stays on the same page and refreshes on a valid 201 response, never calling router.push', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows an accessible success status and re-enables the form after a valid 201 response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Revision created.'));
    expect(screen.getByRole('button', { name: 'Create Revision' })).not.toBeDisabled();
    expect(getTextarea()).not.toBeDisabled();
  });

  it('clears the textarea only after the response has been validated as successful', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(getTextarea()).toHaveValue('');
  });

  it('preserves the entered content after a failed submission', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(getTextarea()).toHaveValue('Revised itinerary.');
  });

  it('allows retry after a failed submission — the button re-enables and a second submit issues a second request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { version: { id: 'v-2', proposalId: PROPOSAL_ID } }),
    );
    renderPanel();
    const user = userEvent.setup();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await user.click(screen.getByRole('button', { name: 'Create Revision' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Create Revision' })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Create Revision' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('shows a field-level error for a VALIDATION_ERROR naming content', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'content', message: 'content must be at most 20,000 characters' }],
        },
      }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() =>
      expect(screen.getByText('content must be at most 20,000 characters')).toBeInTheDocument(),
    );
    expect(getTextarea()).toHaveAttribute('aria-invalid', 'true');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server message for PROPOSAL_FORBIDDEN', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'PROPOSAL_FORBIDDEN', message: 'Proposal not found or not accessible.' },
      }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Proposal not found or not accessible.'),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server message for PROPOSAL_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'PROPOSAL_NOT_FOUND', message: 'Proposal not found.' } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Proposal not found.'));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server message for a role-denied/unauthenticated response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

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
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred.'),
    );
  });

  it('shows a generic error when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse(200));
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this revision. Please check your connection and try again.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('does not clear the textarea or show success when the 201 response is missing version.id (incomplete success)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { version: { proposalId: PROPOSAL_ID } }));
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(getTextarea()).toHaveValue('Revised itinerary.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('does not clear the textarea or show success when the 201 response names a conflicting proposalId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { version: { id: 'v-2', proposalId: 'a-different-proposal-id' } }),
    );
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(getTextarea()).toHaveValue('Revised itinerary.');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('accepts a 201 response that omits version.proposalId entirely', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { version: { id: 'v-2' } }));
    renderPanel();

    fireEvent.change(getTextarea(), { target: { value: 'Revised itinerary.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(getTextarea()).toHaveValue('');
  });

  it('never displays raw server/internal error detail or logs the submitted content', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNRESET: raw socket failure at internal-host:5432'));
    renderPanel();

    const secretContent = 'CONFIDENTIAL_REVISION_MARKER Day 1: Arrival.';
    fireEvent.change(getTextarea(), { target: { value: secretContent } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Something went wrong while creating this revision. Please check your connection and try again.',
    );
    expect(alert.textContent).not.toContain('ECONNRESET');
    expect(alert.textContent).not.toContain('internal-host');
    expect(alert.textContent).not.toContain('CONFIDENTIAL_REVISION_MARKER');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('renders no title, reference, publish, Accept, Decline, Request Changes, or Client-picker control', () => {
    renderPanel();

    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/reference/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/client/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^decline$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
  });
});
