// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { EditLeadForm, type EditLeadFormProps } from './EditLeadForm';

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

const DEFAULT_PROPS: EditLeadFormProps = {
  leadId: 'lead-1',
  initialFullName: 'Juan Dela Cruz',
  initialSource: 'Contact page',
  initialEmail: 'juan@example.com',
  initialPhone: null,
  initialNotes: 'Called back once',
  initiallyLocked: false,
};

function renderForm(overrides: Partial<EditLeadFormProps> = {}) {
  return render(<EditLeadForm {...DEFAULT_PROPS} {...overrides} />);
}

describe('EditLeadForm', () => {
  it('prepopulates the form with the existing Lead values', () => {
    renderForm();

    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Email')).toHaveValue('juan@example.com');
    // A null field prepopulates as an empty string, not "null" text.
    expect(screen.getByLabelText('Phone')).toHaveValue('');
    expect(screen.getByLabelText('Notes')).toHaveValue('Called back once');
  });

  it('disables Save and sends no request when nothing has changed', async () => {
    const user = userEvent.setup();
    renderForm();

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeDisabled();

    await user.click(saveButton);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits only the fields that actually changed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Phone',
          email: 'juan@example.com',
          phone: null,
          notes: 'Called back once',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/leads/lead-1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ source: 'Phone' });
  });

  it('preserves intentional clearing of an optional field by sending an explicit empty string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Contact page',
          email: null,
          phone: '09171234567',
          notes: 'Called back once',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm({ initialPhone: '09171234567' });

    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // An explicit empty string, not omitted and not `null` — the server's
    // own schema transforms a blank string to `null` (D-022 §3).
    expect(body).toEqual({ email: '' });
  });

  it('blocks submission client-side when clearing would leave both email and phone blank', async () => {
    const user = userEvent.setup();
    renderForm({ initialPhone: null });

    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('At least one of email or phone is required.')).toBeInTheDocument();
  });

  it('updates the confirmed baseline from the server response and calls router.refresh() on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Referral', // server-normalized value, distinct from local input casing/spacing
          email: 'juan@example.com',
          phone: null,
          notes: 'Called back once',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'referral');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lead updated.'));
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // The confirmed server value ("Referral"), not the raw submitted one
    // ("referral"), becomes the new baseline.
    expect(screen.getByLabelText('Source')).toHaveValue('Referral');
    // Save is disabled again — the form is no longer dirty relative to the
    // new baseline.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('renders field-level validation errors from a VALIDATION_ERROR response and preserves entered values', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'source', message: 'source must be at most 200 characters' }],
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByText('source must be at most 200 characters')).toBeInTheDocument(),
    );
    const sourceInput = screen.getByLabelText('Source');
    expect(sourceInput).toHaveAttribute('aria-invalid', 'true');
    expect(sourceInput).toHaveValue('Phone');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('clears a field-level validation error as soon as the user edits that field (regression)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'source', message: 'source must be at most 200 characters' }],
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByText('source must be at most 200 characters')).toBeInTheDocument(),
    );

    // The user starts correcting the flagged field — the stale error
    // describes the value as it was at last validation, not as it is now.
    await user.type(screen.getByLabelText('Source'), ' Call');

    expect(screen.queryByText('source must be at most 200 characters')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Source')).not.toHaveAttribute('aria-invalid');
  });

  it('clears the stale "at least one of email or phone" error when editing phone after clearing email triggered it (regression)', async () => {
    const user = userEvent.setup();
    renderForm({ initialPhone: null });

    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(fetchMock).not.toHaveBeenCalled();
    const sharedError = 'At least one of email or phone is required.';
    expect(screen.getByText(sharedError)).toBeInTheDocument();

    // The error is stored under `email`, but it's jointly determined by
    // both contact fields — editing `phone` (not `email`) resolves it too.
    await user.type(screen.getByLabelText('Phone'), '09171234567');

    expect(screen.queryByText(sharedError)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  });

  it('clears the stale "at least one of email or phone" error when editing email again (regression)', async () => {
    const user = userEvent.setup();
    renderForm({ initialPhone: null });

    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const sharedError = 'At least one of email or phone is required.';
    expect(screen.getByText(sharedError)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'juan@example.com');

    expect(screen.queryByText(sharedError)).not.toBeInTheDocument();
  });

  it('clears a stale form-level error once the user begins correcting the form (regression)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );

    // The user starts correcting the form again — the stale alert from the
    // previous, unrelated failed attempt must not linger.
    await user.type(screen.getByLabelText('Notes'), ' Follow up scheduled.');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clearly displays a duplicate-match warning alongside the success state, without hiding it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Contact page',
          email: 'new@example.com',
          phone: null,
          notes: 'Called back once',
        },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Existing Match',
            status: 'NEW',
            matchedOn: ['EMAIL'],
          },
        ],
        restrictedMatchDetected: true,
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The edit genuinely succeeded — the success message still appears...
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lead updated.'));
    // ...but the duplicate warning is shown too, not swallowed by success.
    expect(screen.getByText(/Existing Match/)).toHaveTextContent('Existing Match (Lead, New)');
    expect(
      screen.getByText(
        'Another possible matching record exists, but its details are unavailable to you.',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['LEAD_FORBIDDEN', 'This lead is no longer accessible to you.'],
    ['LEAD_NOT_FOUND', 'Lead not found.'],
  ])(
    'handles the controlled %s response safely, preserving entered values',
    async (code, message) => {
      fetchMock.mockResolvedValue(
        jsonResponse(code === 'LEAD_NOT_FOUND' ? 404 : 403, { error: { code, message } }),
      );
      const user = userEvent.setup();
      renderForm();

      await user.clear(screen.getByLabelText('Source'));
      await user.type(screen.getByLabelText('Source'), 'Phone');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
      expect(screen.getByLabelText('Source')).toHaveValue('Phone');
    },
  );

  it('replaces the form with a locked notice on a LEAD_LOCKED response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'LEAD_LOCKED',
          message: 'This lead has been converted to a client and can no longer be edited.',
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        screen.getByText('This lead has been converted to a client and can no longer be edited.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
    // Read-only value reflects the last confirmed baseline ("Contact
    // page"), not the rejected, unsaved edit ("Phone") that triggered the
    // LEAD_LOCKED response. Scoped to the Source field's own container,
    // since "Phone" is also a legitimate read-only field label elsewhere
    // in this same locked view.
    const sourceField = screen.getByText('Source').closest('div');
    expect(sourceField).toHaveTextContent('Contact page');
    expect(sourceField).not.toHaveTextContent('Phone');
  });

  it('renders Source, Email, Phone, and Notes as read-only values when initiallyLocked is true, with no editable controls', () => {
    renderForm({ initiallyLocked: true, initialPhone: '09171234567' });

    expect(
      screen.getByText('This lead has been converted to a client and can no longer be edited.'),
    ).toBeInTheDocument();

    // No editable controls for any field on a locked Lead.
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

    // Source, Email, Phone, and Notes remain visible as read-only values.
    expect(screen.getByText('Contact page')).toBeInTheDocument();
    expect(screen.getByText('juan@example.com')).toBeInTheDocument();
    expect(screen.getByText('09171234567')).toBeInTheDocument();
    expect(screen.getByText('Called back once')).toBeInTheDocument();
  });

  it('shows the generic alert and preserves values on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.getByLabelText('Source')).toHaveValue('Phone');
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('shows the generic alert and preserves values when the response body is invalid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    } as Response);
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.getByLabelText('Source')).toHaveValue('Phone');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed success envelope (missing lead.id) and shows the generic alert', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          fullName: 'Juan Dela Cruz',
          source: 'Phone',
          email: null,
          phone: null,
          notes: null,
        },
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed error envelope (empty error.message) and shows the generic alert', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { code: 'LEAD_FORBIDDEN', message: '' } }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while saving');
    expect(alert.textContent).not.toBe('');
  });

  it('rejects a duplicate match whose status is an inherited Object.prototype property', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Phone',
          email: 'juan@example.com',
          phone: null,
          notes: 'Called back once',
        },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'X',
            status: 'constructor',
            matchedOn: ['EMAIL'],
          },
        ],
        restrictedMatchDetected: false,
      }),
    );
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while saving'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

    await user.clear(screen.getByLabelText('Source'));
    await user.type(screen.getByLabelText('Source'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveFetch(
      jsonResponse(200, {
        lead: {
          id: 'lead-1',
          fullName: 'Juan Dela Cruz',
          source: 'Phone',
          email: 'juan@example.com',
          phone: null,
          notes: 'Called back once',
        },
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
