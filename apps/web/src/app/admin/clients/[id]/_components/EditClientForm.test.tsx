// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { EditClientForm, type EditClientFormProps } from './EditClientForm';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function clientResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'client-1',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: '+639171234567',
    address: '123 Rizal St, Manila',
    nationality: 'Filipino',
    dateOfBirth: '1990-05-14',
    emergencyContact: 'Maria Dela Cruz — +639179876543',
    notes: 'Prefers email contact',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    assignment: null,
    originatingLeads: [],
    ...overrides,
  };
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

const DEFAULT_PROPS: EditClientFormProps = {
  clientId: 'client-1',
  initialFullName: 'Juan Dela Cruz',
  initialEmail: 'juan@example.com',
  initialPhone: '+639171234567',
  initialAddress: '123 Rizal St, Manila',
  initialNationality: 'Filipino',
  initialDateOfBirth: '1990-05-14',
  initialEmergencyContact: 'Maria Dela Cruz — +639179876543',
  initialNotes: 'Prefers email contact',
  initialUpdatedAt: '2026-07-23T00:00:00.000Z',
};

function renderForm(overrides: Partial<EditClientFormProps> = {}) {
  return render(<EditClientForm {...DEFAULT_PROPS} {...overrides} />);
}

describe('EditClientForm', () => {
  it('prepopulates the form with the existing Client values', () => {
    renderForm();

    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Email')).toHaveValue('juan@example.com');
    expect(screen.getByLabelText('Phone')).toHaveValue('+639171234567');
    expect(screen.getByLabelText('Address')).toHaveValue('123 Rizal St, Manila');
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino');
    expect(screen.getByLabelText('Date of birth')).toHaveValue('1990-05-14');
    expect(screen.getByLabelText('Emergency contact')).toHaveValue(
      'Maria Dela Cruz — +639179876543',
    );
    expect(screen.getByLabelText('Notes')).toHaveValue('Prefers email contact');
  });

  it('prepopulates every nullable field, including dateOfBirth, as an empty string — never "null" text', () => {
    renderForm({
      initialEmail: null,
      initialPhone: null,
      initialAddress: null,
      initialNationality: null,
      initialDateOfBirth: null,
      initialEmergencyContact: null,
      initialNotes: null,
    });

    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Phone')).toHaveValue('');
    expect(screen.getByLabelText('Address')).toHaveValue('');
    expect(screen.getByLabelText('Nationality')).toHaveValue('');
    expect(screen.getByLabelText('Date of birth')).toHaveValue('');
    expect(screen.getByLabelText('Emergency contact')).toHaveValue('');
    expect(screen.getByLabelText('Notes')).toHaveValue('');
  });

  it('disables Save and sends no request when nothing has changed', async () => {
    const user = userEvent.setup();
    renderForm();

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeDisabled();

    await user.click(saveButton);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits only the changed field plus expectedUpdatedAt, with the exact PATCH URL/method/headers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse({ nationality: 'Filipino-American' }) }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/clients/client-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      nationality: 'Filipino-American',
      expectedUpdatedAt: '2026-07-23T00:00:00.000Z',
    });
  });

  it('never includes assignment, originatingLeads, createdAt, id, normalizedEmail, or normalizedPhone in the request body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse({ notes: 'Updated' }) }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Updated');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    for (const key of [
      'assignment',
      'originatingLeads',
      'createdAt',
      'id',
      'normalizedEmail',
      'normalizedPhone',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('preserves intentional clearing of an optional text field by sending an explicit empty string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { client: clientResponse({ address: null }) }));
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Address'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ address: '', expectedUpdatedAt: '2026-07-23T00:00:00.000Z' });
  });

  it('preserves an explicit clear of dateOfBirth as an empty string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse({ dateOfBirth: null }) }),
    );
    renderForm();

    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ dateOfBirth: '', expectedUpdatedAt: '2026-07-23T00:00:00.000Z' });
  });

  it('blocks submission client-side when fullName is cleared to blank', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Full name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Full name is required.')).toBeInTheDocument();
  });

  it('uses the returned client as the new baseline, and its updatedAt for the very next submission', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          client: clientResponse({
            nationality: 'Filipino-American',
            updatedAt: '2026-07-24T00:00:00.000Z',
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          client: clientResponse({
            nationality: 'Filipino-American',
            notes: 'Second update',
            updatedAt: '2026-07-25T00:00:00.000Z',
          }),
        }),
      );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));
    // The confirmed server value becomes the new baseline — Save is
    // disabled again since the form is no longer dirty relative to it.
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Second update');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    // Uses the FIRST response's fresh updatedAt, never the original
    // initialUpdatedAt prop — proves the concurrency token was refreshed.
    expect(secondBody).toEqual({
      notes: 'Second update',
      expectedUpdatedAt: '2026-07-24T00:00:00.000Z',
    });
  });

  it('preserves an in-progress second edit through the ordinary post-save router.refresh(), and still sends the fresh updatedAt', async () => {
    const T2 = '2026-07-24T00:00:00.000Z';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        client: clientResponse({ nationality: 'Filipino-American', updatedAt: T2 }),
      }),
    );
    const user = userEvent.setup();
    const { rerender } = renderForm();

    // First edit, saved successfully — confirms T2 as the new baseline and
    // concurrency token.
    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));

    // The user starts a SECOND, still-unsaved edit before router.refresh()
    // (called as part of the save above) has resolved.
    await user.clear(screen.getByLabelText('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Second draft, not yet saved');

    // Simulates that router.refresh() now resolving: the parent Server
    // Component re-renders with the SAME T2 the successful PATCH already
    // confirmed. This ordinary post-save refresh must never discard the
    // in-progress second draft — only an explicit CLIENT_CONFLICT recovery
    // (a genuinely different, unknown value) may reset the form.
    rerender(
      <EditClientForm
        {...DEFAULT_PROPS}
        initialNationality="Filipino-American"
        initialUpdatedAt={T2}
      />,
    );

    expect(screen.getByLabelText('Notes')).toHaveValue('Second draft, not yet saved');
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        client: clientResponse({
          nationality: 'Filipino-American',
          notes: 'Second draft, not yet saved',
          updatedAt: '2026-07-25T00:00:00.000Z',
        }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    // The second draft's own PATCH still uses T2 — the value confirmed by
    // the FIRST successful save, never the original mount-time
    // initialUpdatedAt prop.
    expect(secondBody).toEqual({
      notes: 'Second draft, not yet saved',
      expectedUpdatedAt: T2,
    });
  });

  it('shows a success message and calls router.refresh() after a valid update', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse({ notes: 'Updated' }) }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Updated');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('renders field-level validation errors from a VALIDATION_ERROR response and preserves entered values', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'nationality', message: 'nationality must be at most 100 characters' }],
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByText('nationality must be at most 100 characters')).toBeInTheDocument(),
    );
    const nationalityInput = screen.getByLabelText('Nationality');
    expect(nationalityInput).toHaveAttribute('aria-invalid', 'true');
    expect(nationalityInput).toHaveValue('Filipino-American');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the plain message for a VALIDATION_ERROR carrying no field-level details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A client must retain at least one of email or phone.',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'A client must retain at least one of email or phone.',
      ),
    );
  });

  it('requires an explicit refresh on CLIENT_CONFLICT, disabling Save and never auto-retrying', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'CLIENT_CONFLICT',
          message: 'This client has changed since it was last loaded. Refresh and try again.',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This client has changed since it was last loaded. Refresh and try again.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clicking "Refresh and try again" only calls router.refresh(); it
    // never resubmits the pending patch on its own.
    await user.click(screen.getByRole('button', { name: 'Refresh and try again' }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from CLIENT_CONFLICT once the parent supplies fresh authoritative props', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'CLIENT_CONFLICT',
          message: 'This client has changed since it was last loaded. Refresh and try again.',
        },
      }),
    );
    const user = userEvent.setup();
    const { rerender } = renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled(),
    );

    // Recovery requires the explicit click — not just a prop change.
    await user.click(screen.getByRole('button', { name: 'Refresh and try again' }));
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Simulates the parent Server Component re-rendering with a genuinely
    // fresh authoritative read, as would follow that router.refresh().
    rerender(
      <EditClientForm
        {...DEFAULT_PROPS}
        initialNationality="Someone Else's Edit"
        initialUpdatedAt="2026-07-24T00:00:00.000Z"
      />,
    );

    expect(screen.getByLabelText('Nationality')).toHaveValue("Someone Else's Edit");
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Not dirty relative to the new baseline, and no longer conflict-locked.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    // Only the original PATCH was ever sent — never a second one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never resets or clears the conflict from a prop change alone — only after the explicit refresh click', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'CLIENT_CONFLICT',
          message: 'This client has changed since it was last loaded. Refresh and try again.',
        },
      }),
    );
    const user = userEvent.setup();
    const { rerender } = renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This client has changed since it was last loaded. Refresh and try again.',
      ),
    );

    // Fresh props arrive WITHOUT any click on "Refresh and try again" —
    // e.g. an unrelated router.refresh() elsewhere already resolved. The
    // rejected draft and the conflict alert must remain exactly as they
    // were; nothing may reset on a prop change alone.
    rerender(
      <EditClientForm
        {...DEFAULT_PROPS}
        initialNationality="Someone Else's Edit"
        initialUpdatedAt="2026-07-24T00:00:00.000Z"
      />,
    );

    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This client has changed since it was last loaded. Refresh and try again.',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The explicit click now recovers immediately, using the already-fresh
    // props — no second PATCH, no further refresh needed.
    await user.click(screen.getByRole('button', { name: 'Refresh and try again' }));

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Nationality')).toHaveValue("Someone Else's Edit");
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when the parent already carries a newer timestamp before CLIENT_CONFLICT even arrives, still waits for the explicit click, then recovers immediately with no further refresh needed', async () => {
    const user = userEvent.setup();
    const { rerender } = renderForm();

    // Simulates that the parent's props had ALREADY moved on — from some
    // earlier, unrelated router.refresh() — before this conflict-triggering
    // submission's response ever comes back. `conflict` is still false
    // here, so this alone changes nothing yet (the ordinary post-save
    // guard never fires on props changing while not in conflict).
    rerender(<EditClientForm {...DEFAULT_PROPS} initialUpdatedAt="2026-07-24T00:00:00.000Z" />);

    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'CLIENT_CONFLICT',
          message: 'This client has changed since it was last loaded. Refresh and try again.',
        },
      }),
    );

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This client has changed since it was last loaded. Refresh and try again.',
      ),
    );
    // Even though the parent's props already satisfy the "fresh" condition
    // at this exact moment, no reset occurs before the button is clicked —
    // the conflict alert and the rejected draft both remain visible.
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Refresh and try again' }));

    // Recovery happens immediately, using the props already on hand — the
    // click only calls router.refresh(); no second PATCH is ever sent, and
    // no additional prop update is needed for the reset to apply.
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it.each([
    ['CLIENT_FORBIDDEN', 'You do not have access to this client.'],
    ['CLIENT_NOT_FOUND', 'Client not found.'],
  ])(
    'shows a safe inaccessible/missing message for %s, preserving entered values',
    async (code, message) => {
      fetchMock.mockResolvedValue(
        jsonResponse(code === 'CLIENT_NOT_FOUND' ? 404 : 403, { error: { code, message } }),
      );
      const user = userEvent.setup();
      renderForm();

      await user.clear(screen.getByLabelText('Nationality'));
      await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
      expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');
    },
  );

  it('shows the generic alert and preserves values on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino-American');
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('shows the generic alert when the response body is invalid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    } as Response);
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed success envelope (missing client.id) and shows the generic alert', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        client: {
          fullName: 'Juan Dela Cruz',
          email: null,
          phone: null,
          address: null,
          nationality: null,
          dateOfBirth: null,
          emergencyContact: null,
          notes: null,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
          assignment: null,
          originatingLeads: [],
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a response where duplicateMatches is present without restrictedMatchDetected', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse(), duplicateMatches: [] }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('rejects a response where restrictedMatchDetected is present without duplicateMatches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { client: clientResponse(), restrictedMatchDetected: false }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders authorized duplicate match metadata using only type/id/fullName/status/matchedOn', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        client: clientResponse({ email: 'new@example.com' }),
        duplicateMatches: [
          { type: 'CLIENT', id: 'client-9', fullName: 'Existing Match', matchedOn: ['EMAIL'] },
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Lead Match',
            status: 'QUALIFIED',
            matchedOn: ['PHONE'],
          },
        ],
        restrictedMatchDetected: false,
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));
    expect(screen.getByText(/Existing Match/)).toHaveTextContent(
      'Existing Match (Client) — matched on email',
    );
    expect(screen.getByText(/Lead Match/)).toHaveTextContent(
      'Lead Match (Lead, QUALIFIED) — matched on phone',
    );
  });

  it('renders a single generic warning when restrictedMatchDetected is true, exposing no candidate metadata', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        client: clientResponse({ email: 'new@example.com' }),
        duplicateMatches: [],
        restrictedMatchDetected: true,
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'Another possible matching record exists, but its details are unavailable to you.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('accepts a successful update alongside a duplicate warning — a duplicate is advisory only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        client: clientResponse({ email: 'new@example.com' }),
        duplicateMatches: [
          { type: 'CLIENT', id: 'client-9', fullName: 'Existing Match', matchedOn: ['EMAIL'] },
        ],
        restrictedMatchDetected: false,
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The edit genuinely succeeded — the success message still appears
    // alongside the warning, never swallowed by it.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));
    expect(screen.getByText(/Existing Match/)).toBeInTheDocument();
  });

  it('never reads or renders normalizedEmail/normalizedPhone or other unrelated response properties, even if present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        client: {
          ...clientResponse({ nationality: 'Filipino-American' }),
          normalizedEmail: 'normalized-marker@example.com',
          normalizedPhone: '+639170000000',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Client updated.'));
    expect(screen.queryByText('normalized-marker@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('+639170000000')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('normalized-marker@example.com')).not.toBeInTheDocument();
  });

  it('disables Save while a request is pending, blocking repeated submission', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveFetch(
      jsonResponse(200, { client: clientResponse({ nationality: 'Filipino-American' }) }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('disables every field control while a request is pending', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Nationality'));
    await user.type(screen.getByLabelText('Nationality'), 'Filipino-American');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByLabelText('Full name')).toBeDisabled();
    expect(screen.getByLabelText('Nationality')).toBeDisabled();
    expect(screen.getByLabelText('Notes')).toBeDisabled();
  });
});
