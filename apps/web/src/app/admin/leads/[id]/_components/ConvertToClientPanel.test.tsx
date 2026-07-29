// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import {
  ConvertToClientPanel,
  type ConversionCandidate,
  type ConvertToClientPanelProps,
} from './ConvertToClientPanel';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LEAD_ID = 'lead-1';

function renderPanel(overrides: Partial<ConvertToClientPanelProps> = {}) {
  const props: ConvertToClientPanelProps = {
    leadId: LEAD_ID,
    accessibleMatches: [],
    restrictedMatchDetected: false,
    ...overrides,
  };
  return render(<ConvertToClientPanel {...props} />);
}

function successBody(
  overrides: Partial<{ clientId: string; fullName: string; clientCreated: boolean }> = {},
) {
  const clientId = overrides.clientId ?? 'client-1';
  const fullName = overrides.fullName ?? 'Juan Dela Cruz';
  const clientCreated = overrides.clientCreated ?? true;
  return {
    lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId },
    client: { id: clientId, fullName },
    clientCreated,
  };
}

async function continueAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('ConvertToClientPanel', () => {
  describe('no matching Client', () => {
    it('makes "Create a new Client" the pre-selected, available action', () => {
      renderPanel();

      expect(screen.getByLabelText('Create a new Client')).toBeChecked();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });

    it('opens confirmation from the first action without calling fetch', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        screen.getByText("This will create a new Client from this lead's information."),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    });

    it('sends exactly { expectedStatus: "QUALIFIED" } on confirmation', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, successBody()));
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/leads/lead-1/conversion');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ expectedStatus: 'QUALIFIED' });
    });
  });

  describe('accessible Client matches', () => {
    const CANDIDATES: ConversionCandidate[] = [
      { id: 'client-1', fullName: 'Maria Santos', matchedOn: ['EMAIL'] },
      { id: 'client-2', fullName: 'Jose Reyes', matchedOn: ['PHONE'] },
    ];

    it('shows only fullName and matched-channel labels for each candidate', () => {
      renderPanel({ accessibleMatches: CANDIDATES });

      expect(screen.getByLabelText('Maria Santos — matched on Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Jose Reyes — matched on Phone')).toBeInTheDocument();
      // No other Client field (email, phone, notes, assignment) is ever
      // rendered — only fullName and the matched channel label above.
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('does not offer create-new when any matching Client exists', () => {
      renderPanel({ accessibleMatches: CANDIDATES });

      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
      expect(screen.queryByText('Create a new Client')).not.toBeInTheDocument();
    });

    it('renders no free-text Client-id input anywhere', () => {
      renderPanel({ accessibleMatches: CANDIDATES });

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('disables Continue until a candidate is selected', () => {
      renderPanel({ accessibleMatches: CANDIDATES });

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('shows the accessible candidates together with a generic restricted notice, without exposing restricted metadata', () => {
      renderPanel({ accessibleMatches: CANDIDATES, restrictedMatchDetected: true });

      expect(screen.getByLabelText('Maria Santos — matched on Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Jose Reyes — matched on Phone')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Another possible matching client exists, but its details are unavailable to you.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('sends the exact selected candidate clientId on confirmation', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          successBody({ clientId: 'client-2', fullName: 'Jose Reyes', clientCreated: false }),
        ),
      );
      const user = userEvent.setup();
      renderPanel({ accessibleMatches: CANDIDATES });

      await user.click(screen.getByLabelText('Jose Reyes — matched on Phone'));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(
        screen.getByText('This will link this lead to the existing client "Jose Reyes".'),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ expectedStatus: 'QUALIFIED', clientId: 'client-2' });
    });
  });

  describe('restricted-only matches', () => {
    it('renders a generic assistance message with no restricted Client metadata', () => {
      renderPanel({ accessibleMatches: [], restrictedMatchDetected: true });

      expect(screen.getByText(/request Admin\/Manager assistance/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('provides no usable create-new or link submission path', () => {
      renderPanel({ accessibleMatches: [], restrictedMatchDetected: true });

      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    });
  });

  describe('revalidates state after option-prop changes (Stage F review correction 2)', () => {
    const ONE_CANDIDATE: ConversionCandidate[] = [
      { id: 'client-1', fullName: 'Maria Santos', matchedOn: ['EMAIL'] },
    ];
    const TWO_CANDIDATES: ConversionCandidate[] = [
      { id: 'client-1', fullName: 'Maria Santos', matchedOn: ['EMAIL'] },
      { id: 'client-2', fullName: 'Jose Reyes', matchedOn: ['PHONE'] },
    ];

    it('re-selects create-new as the effective, pre-selected action once matches disappear, replacing a stale candidate selection', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPanel({ accessibleMatches: ONE_CANDIDATE });

      await user.click(screen.getByLabelText('Maria Santos — matched on Email'));
      expect(screen.getByLabelText('Maria Santos — matched on Email')).toBeChecked();

      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={[]}
          restrictedMatchDetected={false}
        />,
      );

      expect(screen.getByLabelText('Create a new Client')).toBeChecked();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });

    it('makes stale create-new state unusable immediately once a matching Client appears', () => {
      const { rerender } = renderPanel();

      expect(screen.getByLabelText('Create a new Client')).toBeChecked();

      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={ONE_CANDIDATE}
          restrictedMatchDetected={false}
        />,
      );

      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('makes stale create-new state unusable immediately once only a restricted match appears', () => {
      const { rerender } = renderPanel();

      expect(screen.getByLabelText('Create a new Client')).toBeChecked();

      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={[]}
          restrictedMatchDetected={true}
        />,
      );

      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      expect(screen.getByText(/request Admin\/Manager assistance/)).toBeInTheDocument();
    });

    it('disables Continue when the previously selected candidate is removed from accessibleMatches', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPanel({ accessibleMatches: TWO_CANDIDATES });

      await user.click(screen.getByLabelText('Maria Santos — matched on Email'));
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={[TWO_CANDIDATES[1]!]}
          restrictedMatchDetected={false}
        />,
      );

      expect(screen.queryByLabelText('Maria Santos — matched on Email')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('does not submit a stale confirmation once the confirmed candidate is no longer authorized by current props', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPanel({ accessibleMatches: ONE_CANDIDATE });

      await user.click(screen.getByLabelText('Maria Santos — matched on Email'));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(
        screen.getByText('This will link this lead to the existing client "Maria Santos".'),
      ).toBeInTheDocument();

      // The candidate disappears from the options while the user sits on
      // the confirm screen (e.g. another panel's router.refresh()).
      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={[]}
          restrictedMatchDetected={false}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(fetchMock).not.toHaveBeenCalled();
      // Bounced back to the choose step, now correctly reflecting the
      // fresh, match-free options.
      expect(screen.getByLabelText('Create a new Client')).toBeInTheDocument();
    });

    it('does not submit a stale create-new confirmation once a matching Client has since appeared', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPanel();

      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(
        screen.getByText("This will create a new Client from this lead's information."),
      ).toBeInTheDocument();

      rerender(
        <ConvertToClientPanel
          leadId={LEAD_ID}
          accessibleMatches={ONE_CANDIDATE}
          restrictedMatchDetected={false}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Maria Santos — matched on Email')).toBeInTheDocument();
    });
  });

  describe('explicit confirmation', () => {
    it('returns to the choose step without a request when Cancel is clicked', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
      expect(screen.getByLabelText('Create a new Client')).toBeInTheDocument();
    });

    it('disables Confirm while a request is pending, blocking repeated submission', async () => {
      let resolveFetch: (value: Response) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(screen.getByRole('button', { name: 'Converting…' })).toBeDisabled();

      // Wait for the confirmed outcome the resolved fetch actually
      // produces — never a fetch call count that was already true before
      // resolution — so the test only ends once the full async chain
      // (response.json(), success validation, router.refresh()) has
      // actually settled (Stage F review correction 3).
      resolveFetch(jsonResponse(200, successBody()));
      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirmed success', () => {
    it('validates the response, renders accessible success feedback, and calls router.refresh exactly once', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, successBody({ fullName: 'Maria Santos', clientCreated: true })),
      );
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Converted'));
      expect(screen.getByRole('status')).toHaveTextContent('Maria Santos');
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('reports a link-existing result distinctly from a create-new result', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, successBody({ fullName: 'Maria Santos', clientCreated: false })),
      );
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'linked to the existing client "Maria Santos"',
        ),
      );
    });

    it('prevents another conversion once success is recorded, before refreshed props arrive', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, successBody()));
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('strict confirmed-conversion response (Stage F review correction 1)', () => {
    async function expectRejectedAsGenericError(user: ReturnType<typeof userEvent.setup>) {
      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while converting this lead to a client.',
        ),
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(refreshMock).not.toHaveBeenCalled();
    }

    it("rejects a response whose lead.id does not match this panel's leadId", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: 'some-other-lead', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' },
          client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('rejects a response whose lead.status is a valid but wrong LeadStatus', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'QUALIFIED', clientId: 'client-1' },
          client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('rejects a response with a null lead.clientId', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId: null },
          client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('rejects a response whose lead.clientId does not equal client.id', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' },
          client: { id: 'client-2', fullName: 'Juan Dela Cruz' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('rejects a response with an empty client.fullName', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' },
          client: { id: 'client-1', fullName: '' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('rejects a response with a non-boolean clientCreated', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' },
          client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
          clientCreated: 'true',
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await expectRejectedAsGenericError(user);
    });

    it('accepts a well-formed response with an exactly matching leadId and consistent Client ids', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          lead: { id: LEAD_ID, status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' },
          client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
          clientCreated: true,
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure handling', () => {
    it('shows the controlled API error message and does not call router.refresh', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, {
          error: {
            code: 'CLIENT_MATCH_REQUIRES_LINK',
            message:
              'A matching client already exists. Select an existing client to link instead of creating a new one.',
          },
        }),
      );
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('A matching client already exists.'),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the generic alert for a malformed success body', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { lead: { id: LEAD_ID, status: 'toString' } }));
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while converting this lead to a client.',
        ),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the generic alert for a malformed/non-JSON error body', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async (): Promise<unknown> => {
          throw new SyntaxError('Unexpected token');
        },
      } as Response);
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while converting this lead to a client.',
        ),
      );
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('shows the generic alert for a well-formed but incomplete error envelope', async () => {
      fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: '', message: 'Conflict.' } }));
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Something went wrong while converting this lead to a client.',
      );
    });

    it('shows the generic alert on a rejected fetch/network failure, never a raw error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      renderPanel();

      await continueAndConfirm(user);

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while converting this lead to a client.',
        ),
      );
      expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
      expect(refreshMock).not.toHaveBeenCalled();
    });
  });
});
