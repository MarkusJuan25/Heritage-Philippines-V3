// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { NewLeadForm } from './NewLeadForm';

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fillValidRequiredFields() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Full name'), 'Juan Dela Cruz');
  await user.type(screen.getByLabelText('Source'), 'Contact page');
  await user.type(screen.getByLabelText('Phone'), '09171234567');
  return user;
}

describe('NewLeadForm', () => {
  it('renders every field with an accessible label, plus the submit control', () => {
    render(<NewLeadForm />);

    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Lead' })).toBeInTheDocument();
  });

  it('requires at least one of email or phone before sending — blocks the request client-side', async () => {
    const user = userEvent.setup();
    render(<NewLeadForm />);

    await user.type(screen.getByLabelText('Full name'), 'Juan Dela Cruz');
    await user.type(screen.getByLabelText('Source'), 'Contact page');
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('At least one of email or phone is required.')).toBeInTheDocument();
  });

  it('sends a correct POST request to /api/leads and never includes a status field', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/leads');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      fullName: 'Juan Dela Cruz',
      source: 'Contact page',
      email: '',
      phone: '09171234567',
      notes: '',
    });
    expect(body).not.toHaveProperty('status');
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<NewLeadForm />);
    await fillValidRequiredFields();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();

    resolveFetch(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [],
        restrictedMatchDetected: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'View Lead' })).toBeInTheDocument(),
    );
  });

  it('maps server VALIDATION_ERROR details to the correct fields and preserves entered values', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [
            { path: 'fullName', message: 'fullName must be at most 200 characters' },
            { path: 'notes', message: 'notes must be at most 2000 characters' },
          ],
        },
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByText('fullName must be at most 200 characters')).toBeInTheDocument(),
    );
    expect(screen.getByText('notes must be at most 2000 characters')).toBeInTheDocument();

    const fullNameInput = screen.getByLabelText('Full name');
    expect(fullNameInput).toHaveAttribute('aria-invalid', 'true');
    expect(fullNameInput).toHaveAccessibleDescription('fullName must be at most 200 characters');

    // Entered values survive the controlled API failure.
    expect(fullNameInput).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Phone')).toHaveValue('09171234567');
  });

  it('preserves entered values and shows a form-level alert for a non-validation controlled error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: 'ROLE_NOT_PERMITTED',
          message: 'This role is not permitted to manage leads.',
        },
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This role is not permitted to manage leads.',
      ),
    );
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
  });

  it('preserves entered values and shows a generic alert when the response body is malformed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async (): Promise<unknown> => {
        throw new SyntaxError('Unexpected token');
      },
    } as Response);
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this lead.',
      ),
    );
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    // Never leaks the raw internal error.
    expect(screen.queryByText(/SyntaxError/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
  });

  it('preserves entered values and shows a generic alert on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this lead.',
      ),
    );
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('renders View Lead and Create another Lead on successful creation', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'View Lead' })).toHaveAttribute(
        'href',
        '/admin/leads/lead-1',
      ),
    );
    expect(screen.getByRole('button', { name: 'Create another Lead' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Juan Dela Cruz');
    // The form itself is replaced by the success state.
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('Create another Lead resets the form and all warnings', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Existing Match',
            status: 'NEW',
            matchedOn: ['PHONE'],
          },
        ],
        restrictedMatchDetected: true,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create another Lead' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Create another Lead' }));

    expect(screen.getByLabelText('Full name')).toHaveValue('');
    expect(screen.getByLabelText('Source')).toHaveValue('');
    expect(screen.getByLabelText('Phone')).toHaveValue('');
    expect(screen.queryByText('Existing Match')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Another possible matching record exists, but its details are unavailable to you.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Lead' })).toBeInTheDocument();
  });

  it('renders visible duplicateMatches from returned authorized metadata only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Juan D. Cruz',
            status: 'UNDER_REVIEW',
            matchedOn: ['EMAIL', 'PHONE'],
          },
          { type: 'CLIENT', id: 'client-3', fullName: 'J. Cruz', matchedOn: ['PHONE'] },
        ],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() => expect(screen.getByText(/Juan D\. Cruz/)).toBeInTheDocument());
    // Renders the shared LEAD_STATUS_LABELS label ("Under Review"), never
    // the raw LeadStatus enum value ("UNDER_REVIEW"/"UNDER REVIEW").
    expect(screen.getByText(/Juan D\. Cruz/)).toHaveTextContent(
      'Juan D. Cruz (Lead, Under Review)',
    );
    expect(screen.queryByText(/UNDER REVIEW/)).not.toBeInTheDocument();
    expect(screen.getByText(/J\. Cruz/)).toHaveTextContent('J. Cruz (Client)');
    // Never invented: no email/phone/notes/assignment data exists in the
    // response, so none can appear.
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    // Exactly two visible matches rendered — no extra row for anything else.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders only the generic notice for restrictedMatchDetected, revealing nothing else', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [],
        restrictedMatchDetected: true,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    const notice = await screen.findByText(
      'Another possible matching record exists, but its details are unavailable to you.',
    );
    // No identity, type, status, or count is ever shown for a restricted
    // match — scoped to the duplicate-warnings section, since "Lead" also
    // legitimately appears elsewhere on this success view ("View Lead").
    const duplicateSection = notice.parentElement as HTMLElement;
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    // Case-insensitive: catches "Lead"/"Client" (the type labels this form
    // itself renders for a visible match), not only the raw uppercase enum
    // form — a stricter proof that no identity/type leaks into this section.
    expect(within(duplicateSection).queryByText(/lead|client/i)).not.toBeInTheDocument();
  });

  it('does not count a restricted match among visible duplicateMatches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Juan D. Cruz',
            status: 'NEW',
            matchedOn: ['EMAIL'],
          },
        ],
        restrictedMatchDetected: true,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    // The restricted match is a separate notice, never folded into the list.
    expect(
      screen.getByText(
        'Another possible matching record exists, but its details are unavailable to you.',
      ),
    ).toBeInTheDocument();
  });

  it('renders visible and restricted duplicate warnings together, kept separate', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          { type: 'CLIENT', id: 'client-3', fullName: 'Ana Reyes', matchedOn: ['PHONE'] },
        ],
        restrictedMatchDetected: true,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() => expect(screen.getByText(/Ana Reyes/)).toBeInTheDocument());
    const restrictedNotice = screen.getByText(
      'Another possible matching record exists, but its details are unavailable to you.',
    );
    expect(restrictedNotice).toBeInTheDocument();
    // The restricted notice is not itself a list item alongside the visible match.
    expect(restrictedNotice.closest('li')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('rejects a 2xx response whose Lead duplicate has an invalid or non-string status, showing the generic error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Juan D. Cruz',
            status: 'NOT_A_REAL_STATUS',
            matchedOn: ['EMAIL'],
          },
        ],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this lead.',
      ),
    );
    // Never renders the malformed match, and never renders a success state.
    expect(screen.queryByText(/Juan D\. Cruz/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Lead' })).not.toBeInTheDocument();
    // Entered values are preserved.
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Phone')).toHaveValue('09171234567');
  });

  it('rejects a 2xx response whose Lead duplicate has a non-string status, showing the generic error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          {
            type: 'LEAD',
            id: 'lead-9',
            fullName: 'Juan D. Cruz',
            status: 42,
            matchedOn: ['EMAIL'],
          },
        ],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this lead.',
      ),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
  });

  it('rejects a 2xx response containing an invalid matchedOn entry, showing the generic error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
        duplicateMatches: [
          { type: 'CLIENT', id: 'client-3', fullName: 'Ana Reyes', matchedOn: ['FAX'] },
        ],
        restrictedMatchDetected: false,
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Something went wrong while creating this lead.',
      ),
    );
    // Never renders the malformed match, and never renders a success state.
    expect(screen.queryByText(/Ana Reyes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Lead' })).not.toBeInTheDocument();
    // Entered values are preserved.
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Phone')).toHaveValue('09171234567');
  });

  it('rejects a VALIDATION_ERROR with malformed details, showing the generic error and never a blank alert', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          // Missing `message` on the first entry, and a non-object second
          // entry — both individually invalid.
          details: [{ path: 'fullName' }, 'not-an-object'],
        },
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while creating this lead.');
    // Never blank, and never the malformed detail's own (missing) message.
    expect(alert.textContent).not.toBe('');
    // Entered values are preserved.
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Phone')).toHaveValue('09171234567');
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'rejects a 2xx response whose Lead duplicate status is the inherited Object.prototype property %s, showing the generic error',
    async (inheritedKey) => {
      fetchMock.mockResolvedValue(
        jsonResponse(201, {
          lead: { id: 'lead-1', fullName: 'Juan Dela Cruz' },
          duplicateMatches: [
            {
              type: 'LEAD',
              id: 'lead-9',
              fullName: 'Juan D. Cruz',
              status: inheritedKey,
              matchedOn: ['EMAIL'],
            },
          ],
          restrictedMatchDetected: false,
        }),
      );
      render(<NewLeadForm />);
      const user = await fillValidRequiredFields();
      await user.click(screen.getByRole('button', { name: 'Create Lead' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while creating this lead.',
        ),
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'View Lead' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    },
  );

  it.each(['', '   '])(
    'rejects a 2xx response whose lead.id is empty or whitespace-only (%s)',
    async (badId) => {
      fetchMock.mockResolvedValue(
        jsonResponse(201, {
          lead: { id: badId, fullName: 'Juan Dela Cruz' },
          duplicateMatches: [],
          restrictedMatchDetected: false,
        }),
      );
      render(<NewLeadForm />);
      const user = await fillValidRequiredFields();
      await user.click(screen.getByRole('button', { name: 'Create Lead' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while creating this lead.',
        ),
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'View Lead' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
      expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    },
  );

  it.each(['', '   '])(
    'rejects a 2xx response whose lead.fullName is empty or whitespace-only (%s)',
    async (badFullName) => {
      fetchMock.mockResolvedValue(
        jsonResponse(201, {
          lead: { id: 'lead-1', fullName: badFullName },
          duplicateMatches: [],
          restrictedMatchDetected: false,
        }),
      );
      render(<NewLeadForm />);
      const user = await fillValidRequiredFields();
      await user.click(screen.getByRole('button', { name: 'Create Lead' }));

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Something went wrong while creating this lead.',
        ),
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'View Lead' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
      expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    },
  );

  it('rejects a VALIDATION_ERROR detail with a known field path but an empty message, without silently accepting a blank field error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not pass validation.',
          details: [{ path: 'fullName', message: '' }],
        },
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while creating this lead.');
    // No blank field-level error was silently accepted onto Full name.
    const fullNameInput = screen.getByLabelText('Full name');
    expect(fullNameInput).not.toHaveAttribute('aria-invalid');
    // Entered values are preserved.
    expect(fullNameInput).toHaveValue('Juan Dela Cruz');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Phone')).toHaveValue('09171234567');
  });

  it('rejects a controlled error envelope whose error.message is empty, showing the generic alert', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'ROLE_NOT_PERMITTED', message: '' },
      }),
    );
    render(<NewLeadForm />);
    const user = await fillValidRequiredFields();
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while creating this lead.');
    expect(alert.textContent).not.toBe('');
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
  });
});
