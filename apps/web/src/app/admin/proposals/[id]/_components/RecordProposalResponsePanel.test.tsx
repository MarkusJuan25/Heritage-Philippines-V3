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

import { RecordProposalResponsePanel } from './RecordProposalResponsePanel';

const VERSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

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
  return render(<RecordProposalResponsePanel versionId={VERSION_ID} versionNumber={4} />);
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('form not found');
  return form;
}

async function fillValidForm() {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
  fireEvent.change(screen.getByLabelText('Client responded at'), {
    target: { value: '2026-08-04T10:00' },
  });
  fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
  fireEvent.change(screen.getByLabelText('Evidence reference'), {
    target: { value: 'Call log #4821' },
  });
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

describe('RecordProposalResponsePanel', () => {
  describe('Accessible rendering', () => {
    it('renders labelled fields, the three response options, help text, and the immutable-response warning', () => {
      renderPanel();

      expect(screen.getByRole('heading', { name: 'Record Client Response' })).toBeInTheDocument();
      expect(
        screen.getByText(/records the client.s response to Version 4 once/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/cannot be edited, replaced, or undone/i)).toBeInTheDocument();

      const select = screen.getByLabelText('Response') as HTMLSelectElement;
      const optionLabels = Array.from(select.options).map((option) => option.textContent);
      expect(optionLabels).toEqual(['Select a response…', 'Accept', 'Decline', 'Request Changes']);
      expect(select).toBeRequired();

      const respondedAtInput = screen.getByLabelText('Client responded at');
      expect(respondedAtInput).toBeInTheDocument();
      expect(respondedAtInput).toBeRequired();

      const methodInput = screen.getByLabelText('Response method') as HTMLInputElement;
      expect(methodInput).toHaveAttribute('maxlength', '100');
      expect(methodInput).toBeRequired();

      const evidenceInput = screen.getByLabelText('Evidence reference') as HTMLTextAreaElement;
      expect(evidenceInput).toHaveAttribute('maxlength', '500');
      expect(evidenceInput).toBeRequired();
      expect(
        screen.getByText(/reference or pointer only.*not pasted correspondence/i),
      ).toBeInTheDocument();

      expect(
        screen.getByRole('button', { name: 'Record Response for Version 4' }),
      ).toBeInTheDocument();
    });
  });

  describe('Client-side validation (no fetch on rejection)', () => {
    it('rejects submission with no response type selected', async () => {
      renderPanel();
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(screen.getByText('Select a response.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects submission with an empty timestamp', async () => {
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(screen.getByText('Enter the date and time the client responded.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('safely rejects an attempt to set a malformed timestamp value, without crashing or bypassing validation', async () => {
      // A real `datetime-local` input (and jsdom, matching that behavior)
      // never accepts a genuinely malformed value string — assigning one
      // resets the input back to an empty value, which this component's
      // existing "empty" branch already rejects. This proves that attempt
      // is handled safely (no fetch, no crash) rather than silently
      // accepted.
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: 'not-a-date' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });

      expect(screen.getByLabelText('Client responded at')).toHaveValue('');

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(screen.getByText('Enter the date and time the client responded.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a blank response method', async () => {
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: '   ' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(screen.getByText('Response method is required.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a response method over 100 characters', async () => {
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      // maxLength on the input would normally cap this at 100 in a real
      // browser — this proves the JS-side length check is also enforced,
      // independent of the HTML attribute.
      fireEvent.change(screen.getByLabelText('Response method'), {
        target: { value: 'a'.repeat(101) },
      });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(
        screen.getByText('Response method must be at most 100 characters.'),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a blank evidence reference', async () => {
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), { target: { value: '   ' } });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(screen.getByText('Evidence reference is required.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an evidence reference over 500 characters', async () => {
      renderPanel();
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'a'.repeat(501) },
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(
        screen.getByText('Evidence reference must be at most 500 characters.'),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('bypassing the disabled button via a direct form submit still enforces validation', async () => {
      const { container } = renderPanel();

      fireEvent.submit(getForm(container));

      expect(screen.getByText('Select a response.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Request construction', () => {
    it('maps Accept/Decline/Request Changes to ACCEPT/DECLINE/REQUEST_CHANGES exactly', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();

      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'Decline');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #4821' },
      });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.responseType).toBe('DECLINE');
    });

    it('converts the local datetime-local value to a timezone-aware ISO-8601 string', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.respondedAt).toBe(new Date('2026-08-04T10:00').toISOString());
      expect(body.respondedAt).toMatch(/Z$/);
    });

    it('trims the response method and evidence reference before submitting', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();

      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), {
        target: { value: '  Phone  ' },
      });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: '  Call log #4821  ' },
      });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.responseMethod).toBe('Phone');
      expect(body.evidenceReference).toBe('Call log #4821');
    });

    it('submits POST /api/proposals/versions/{versionId}/response with the exact header and strict four-key body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/proposals/versions/${VERSION_ID}/response`);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body).sort()).toEqual([
        'evidenceReference',
        'respondedAt',
        'responseMethod',
        'responseType',
      ]);
      expect(body).not.toHaveProperty('expectedCurrentVersionId');
      expect(body).not.toHaveProperty('expectedUpdatedAt');
      expect(body).not.toHaveProperty('role');
    });
  });

  describe('Pending and duplicate-submit prevention', () => {
    it('disables the submit button and shows accessible pending text while in flight', async () => {
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      expect(
        screen.getByRole('button', { name: 'Recording Response for Version 4…' }),
      ).toBeDisabled();
    });

    it('prevents a second request while the first is pending, even bypassing the disabled button', async () => {
      let resolveFetch: (value: Response) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );
      const { container } = renderPanel();
      await fillValidForm();

      const form = getForm(container);
      fireEvent.submit(form);
      fireEvent.submit(form);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolveFetch(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('Success', () => {
    it('shows an accessible success status on a valid 200 response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('Response recorded for Version 4.'),
      );
    });

    it('calls router.refresh() and never router.push()', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('permanently disables the panel during the refresh window, preventing a redundant resubmission', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      const { container } = renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Record Response for Version 4' })).toBeDisabled();

      fireEvent.submit(getForm(container));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Failure and retry', () => {
    it('re-enables the form and preserves entered values after a failed submission', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(500, {
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 4' }),
      ).not.toBeDisabled();
      expect(screen.getByLabelText('Response')).toHaveValue('ACCEPT');
      expect(screen.getByLabelText('Response method')).toHaveValue('Phone');
      expect(screen.getByLabelText('Evidence reference')).toHaveValue('Call log #4821');
    });

    it('allows retry after a failed submission, issuing a second request', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(500, {
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Record Response for Version 4' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Record Response for Version 4' }));
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
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Proposal version not found or not accessible.',
        ),
      );
    });

    it('shows the server message for a role-forbidden/unauthenticated response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, {
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
        }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

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
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred.'),
      );
    });
  });

  describe('Already-recorded / not-current: refresh-only, never resubmit', () => {
    it.each([
      [
        'PROPOSAL_RESPONSE_ALREADY_RECORDED',
        'A response has already been recorded for this proposal version.',
      ],
      [
        'PROPOSAL_VERSION_NOT_CURRENT',
        'A response can only be recorded for the current client-visible version of this proposal.',
      ],
    ])(
      'shows the message and a "Refresh proposal" action for %s, disabling the regular submit',
      async (code, message) => {
        fetchMock.mockResolvedValue(jsonResponse(409, { error: { code, message } }));
        renderPanel();
        await fillValidForm();

        await userEvent
          .setup()
          .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
        expect(screen.getByRole('button', { name: 'Refresh proposal' })).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: 'Record Response for Version 4' }),
        ).toBeDisabled();
      },
    );

    it('the "Refresh proposal" action calls router.refresh() and never resubmits the response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, {
          error: {
            code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
            message: 'A response has already been recorded for this proposal version.',
          },
        }),
      );
      renderPanel();
      await fillValidForm();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Record Response for Version 4' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'Refresh proposal' }));

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('PROPOSAL_CONFLICT', () => {
    const CONFLICT_MESSAGE =
      'This proposal could not be completed because of a conflicting update. Please try again.';

    it('shows the safe server message and permits a deliberate manual retry, never auto-resubmitting', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error: { code: 'PROPOSAL_CONFLICT', message: CONFLICT_MESSAGE } }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Record Response for Version 4' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE));

      // No automatic second request — still exactly one so far.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The regular submit action remains available for a deliberate retry.
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 4' }),
      ).not.toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Record Response for Version 4' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('Malformed/incomplete/mismatched responses', () => {
    it('shows a generic error when the response body is not valid JSON', async () => {
      fetchMock.mockResolvedValue(malformedJsonResponse(200));
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while recording this response. Please check your connection and try again.',
        ),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('treats a missing acceptance as failure, never showing success', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('treats a missing acceptance.id as failure', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { proposalVersionId: VERSION_ID } }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('treats a mismatched acceptance.proposalVersionId as failure', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          acceptance: { id: 'acc-1', proposalVersionId: 'a-different-version-id' },
        }),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(refreshMock).not.toHaveBeenCalled();
    });
  });

  describe('Network failure and logging discipline', () => {
    it('shows a generic message and never logs anything for a network failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fetchMock.mockRejectedValue(
        new Error('ECONNRESET: raw socket failure at internal-host:5432'),
      );
      renderPanel();
      await fillValidForm();

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'Something went wrong while recording this response. Please check your connection and try again.',
      );
      expect(alert.textContent).not.toContain('ECONNRESET');
      expect(alert.textContent).not.toContain('internal-host');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('never logs the entered evidence reference value under any outcome', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fetchMock.mockResolvedValue(
        jsonResponse(500, {
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        }),
      );
      renderPanel();

      const secretEvidence = 'CONFIDENTIAL_EVIDENCE_MARKER call-log-999';
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: secretEvidence },
      });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Record Response for Version 4' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
