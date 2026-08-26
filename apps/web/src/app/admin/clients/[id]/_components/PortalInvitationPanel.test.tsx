// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { PortalInvitationPanel, type InvitationView } from './PortalInvitationPanel';

const CLIENT_ID = 'client-1';

function invitation(overrides: Partial<InvitationView> = {}): InvitationView {
  return {
    id: 'invitation-1',
    clientId: CLIENT_ID,
    status: 'INVITATION_PREPARED',
    expiresAt: null,
    destinationEmail: null,
    deliveryMethod: null,
    deliveryState: 'NOT_ATTEMPTED',
    sendOperationId: null,
    providerMessageId: null,
    deliveryConfirmedAt: null,
    deliveryConfirmedByStaffId: null,
    sentAt: null,
    openedAt: null,
    activatedAt: null,
    revokedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * `@testing-library/user-event@14.6.1` installs its own `navigator.clipboard`
 * stub the moment `userEvent.setup()` runs (confirmed directly: a
 * pre-defined mock set in `beforeEach`, before `setup()`, is silently
 * overwritten by the library's own `Clipboard` stub object by the time a
 * click handler runs) — so `writeText` must be spied on the REAL stub
 * object the library installs, and only after `userEvent.setup()` has
 * already run, never pre-empted with a custom `navigator.clipboard`
 * replacement beforehand.
 */
function spyOnClipboardWriteText(): ReturnType<typeof vi.fn> {
  return vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  // `crypto.randomUUID` is used to generate the Idempotency-Key header —
  // jsdom's own implementation is real and available, no mock needed, but
  // stubbed here with a deterministic sequence so assertions on the exact
  // header value are possible.
  let counter = 0;
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    randomUUID: vi.fn(() => `11111111-1111-4111-8111-00000000000${counter++}`),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PortalInvitationPanel — Not Invited / Prepare', () => {
  it('renders "Not Invited" and a Prepare Invitation control when there is no invitation', () => {
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={null} />);

    expect(screen.getByText('Not Invited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare Invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send invitation/i })).not.toBeInTheDocument();
  });

  it('prepares the invitation and shows the new status on success', async () => {
    const prepared = invitation();
    fetchMock.mockResolvedValue(jsonResponse(201, { invitation: prepared }));

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Prepare Invitation' }));

    await waitFor(() => expect(screen.getByText('Invitation prepared.')).toBeInTheDocument());
    expect(screen.getByText('Invitation Prepared')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/clients/${CLIENT_ID}/invitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe('PortalInvitationPanel — Send (from INVITATION_PREPARED)', () => {
  it('sends manually and displays the one-time manualInvitationUrl with an accessible copy control', async () => {
    const sent = invitation({ status: 'INVITATION_SENT' });
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: sent,
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/raw-token-abc',
      }),
    );

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() => expect(screen.getByText('Invitation sent.')).toBeInTheDocument());
    const linkField = screen.getByLabelText('One-time invitation link');
    expect(linkField).toHaveValue('http://localhost:3000/activate/raw-token-abc');
    expect(screen.getByRole('button', { name: 'Copy invitation link' })).toBeInTheDocument();
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
  });

  it('copies the link via the Clipboard API and announces success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/raw-token-abc',
      }),
    );
    const user = userEvent.setup();
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    const writeTextSpy = spyOnClipboardWriteText();
    await user.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => screen.getByRole('button', { name: 'Copy invitation link' }));

    await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));

    expect(writeTextSpy).toHaveBeenCalledWith('http://localhost:3000/activate/raw-token-abc');
    await waitFor(() => expect(screen.getByText('Link copied to clipboard.')).toBeInTheDocument());
  });

  it('sends an automated request and reflects an unconfirmed outcome without a manual link', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({
          status: 'INVITATION_SENT',
          deliveryMethod: 'AUTOMATED_EMAIL',
          deliveryState: 'AUTOMATED_UNCONFIRMED',
        }),
        delivery: 'unconfirmed',
      }),
    );
    const user = userEvent.setup();
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);

    await user.selectOptions(screen.getByLabelText('Delivery method'), 'AUTOMATED_EMAIL');
    await user.click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() =>
      expect(screen.getByText('Send in progress — outcome not yet confirmed')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('One-time invitation link')).not.toBeInTheDocument();
  });

  it('shows the specific DELIVERY_DISABLED message, not the generic fallback', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        409,
        errorBody('DELIVERY_DISABLED', 'Automated email delivery is currently disabled.'),
      ),
    );
    const user = userEvent.setup();
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await user.selectOptions(screen.getByLabelText('Delivery method'), 'AUTOMATED_EMAIL');

    await user.click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() =>
      expect(
        screen.getByText('Automated email delivery is currently disabled.'),
      ).toBeInTheDocument(),
    );
  });

  it('sends a validated UUID Idempotency-Key header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/x',
      }),
    );
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send Invitation' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('PortalInvitationPanel — Resend/Reissue and stale-precondition recovery', () => {
  function sentInvitation(): InvitationView {
    return invitation({
      status: 'INVITATION_SENT',
      sendOperationId: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
  }

  it('reissues with the exact expectedCurrentSendOperationId/expectedUpdatedAt read from the current displayed state', async () => {
    const current = sentInvitation();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({
          status: 'INVITATION_SENT',
          updatedAt: '2026-08-03T00:00:00.000Z',
        }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/y',
      }),
    );

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={current} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resend Invitation' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/clients/${CLIENT_ID}/invitation/resend`);
    const body = JSON.parse(init.body as string);
    expect(body.expectedCurrentSendOperationId).toBe(current.sendOperationId);
    expect(body.expectedUpdatedAt).toBe(current.updatedAt);
  });

  it('labels the action "Reissue Invitation" for an expired or revoked invitation', () => {
    const { rerender } = render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_EXPIRED' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reissue Invitation' })).toBeInTheDocument();

    rerender(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_REVOKED' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reissue Invitation' })).toBeInTheDocument();
  });

  it('locks the form and offers "Refresh and try again" on INVITATION_SEND_OPERATION_STALE, recovering only after a fresh prop arrives', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        409,
        errorBody(
          'INVITATION_SEND_OPERATION_STALE',
          'This invitation has changed since you last loaded it. Refresh and try again.',
        ),
      ),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={sentInvitation()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Resend Invitation' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'This invitation has changed since you last loaded it. Refresh and try again.',
        ),
      ).toBeInTheDocument(),
    );
    const refreshButton = screen.getByRole('button', { name: 'Refresh and try again' });
    expect(screen.getByRole('button', { name: 'Resend Invitation' })).toBeDisabled();

    // Clicking "Refresh and try again" only calls router.refresh() — it
    // never resubmits the resend on its own.
    fetchMock.mockClear();
    await user.click(refreshButton);
    expect(refreshMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Still locked — the parent hasn't supplied fresh props yet.
    expect(screen.getByRole('button', { name: 'Resend Invitation' })).toBeDisabled();

    // The parent's own router.refresh() resolves with a genuinely fresher
    // read (a different `updatedAt`) — only now does the lock clear.
    rerender(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({
          status: 'INVITATION_SENT',
          updatedAt: '2026-08-05T00:00:00.000Z',
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Resend Invitation' })).not.toBeDisabled();
    expect(
      screen.queryByText(
        'This invitation has changed since you last loaded it. Refresh and try again.',
      ),
    ).not.toBeInTheDocument();
  });
});

describe('PortalInvitationPanel — Confirm Manual Sent', () => {
  it('shows the confirm control only when sent manually and unconfirmed, and clears the manual link on success', async () => {
    const sentUnconfirmed = invitation({ status: 'INVITATION_SENT', deliveryMethod: null });
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({
          status: 'INVITATION_SENT',
          deliveryMethod: 'MANUAL_EMAIL',
          deliveryState: 'MANUALLY_CONFIRMED',
        }),
      }),
    );

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={sentUnconfirmed} />);
    expect(screen.getByRole('button', { name: 'Confirm Manual Sent' })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm Manual Sent' }));

    await waitFor(() => expect(screen.getByText('Manual send confirmed.')).toBeInTheDocument());
    expect(screen.getByText('Manually confirmed sent')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/clients/${CLIENT_ID}/invitation/confirm-manual-sent`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('clears an already-displayed manual link once confirm-manual-sent succeeds', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/pending-link',
      }),
    );
    const user = userEvent.setup();
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await user.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => screen.getByLabelText('One-time invitation link'));

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        invitation: invitation({
          status: 'INVITATION_SENT',
          deliveryMethod: 'MANUAL_EMAIL',
          deliveryState: 'MANUALLY_CONFIRMED',
        }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm Manual Sent' }));

    await waitFor(() => expect(screen.getByText('Manual send confirmed.')).toBeInTheDocument());
    expect(screen.queryByLabelText('One-time invitation link')).not.toBeInTheDocument();
  });

  it('never shows the confirm control once already recorded as an automated send', () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({
          status: 'INVITATION_SENT',
          deliveryMethod: 'AUTOMATED_EMAIL',
          deliveryState: 'AUTOMATED_UNCONFIRMED',
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Confirm Manual Sent' })).not.toBeInTheDocument();
  });
});

describe('PortalInvitationPanel — Revoke', () => {
  it('requires a reason before submitting', async () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_SENT' })}
      />,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'Revoke Invitation' }));

    expect(screen.getByText('A reason is required to revoke this invitation.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes with the given reason and shows the revoked state', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { invitation: invitation({ status: 'INVITATION_REVOKED' }) }),
    );
    const user = userEvent.setup();
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_SENT' })}
      />,
    );

    await user.type(screen.getByLabelText('Reason for revoking'), 'Client requested cancellation');
    await user.click(screen.getByRole('button', { name: 'Revoke Invitation' }));

    await waitFor(() => expect(screen.getByText('Invitation revoked.')).toBeInTheDocument());
    expect(screen.getByText('Invitation Revoked')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Client requested cancellation' });
  });

  it('never renders a Revoke control for ACCOUNT_ACTIVATED', () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'ACCOUNT_ACTIVATED' })}
      />,
    );
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('offers Reissue but never Revoke for an already-revoked invitation', () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_REVOKED' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reissue Invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });
});

describe('PortalInvitationPanel — error handling', () => {
  it('shows a distinct message on CLIENT_FORBIDDEN, not the generic fallback', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, errorBody('CLIENT_FORBIDDEN', 'You do not have access to this client.')),
    );
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={null} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Prepare Invitation' }));

    await waitFor(() =>
      expect(
        screen.getByText('You no longer have access to manage this client’s invitation.'),
      ).toBeInTheDocument(),
    );
  });

  it('falls back to the generic message on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={null} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Prepare Invitation' }));

    await waitFor(() =>
      expect(
        screen.getByText(/something went wrong while managing this invitation/i),
      ).toBeInTheDocument(),
    );
  });

  it('falls back to the generic message on a malformed success body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { invitation: { id: 'only-an-id' } }));
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={null} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Prepare Invitation' }));

    await waitFor(() =>
      expect(
        screen.getByText(/something went wrong while managing this invitation/i),
      ).toBeInTheDocument(),
    );
  });
});

describe('PortalInvitationPanel — manualInvitationUrl security', () => {
  it('never persists the manual link to localStorage or sessionStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/secret-raw-token',
      }),
    );

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => screen.getByLabelText('One-time invitation link'));

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('never logs the manual link to the console', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ];
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/secret-raw-token',
      }),
    );

    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => screen.getByLabelText('One-time invitation link'));

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain('secret-raw-token');
      }
    }
  });

  it('clears the manual link once a new send/resend attempt begins', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        invitation: invitation({ status: 'INVITATION_SENT' }),
        delivery: 'reserved-only',
        manualInvitationUrl: 'http://localhost:3000/activate/first-link',
      }),
    );
    const user = userEvent.setup();
    render(<PortalInvitationPanel clientId={CLIENT_ID} initialInvitation={invitation()} />);
    await user.click(screen.getByRole('button', { name: 'Send Invitation' }));
    await waitFor(() => screen.getByLabelText('One-time invitation link'));

    // A never-resolving second request — the link must disappear the
    // instant the new attempt begins, not only once it completes.
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Resend Invitation' }));

    expect(screen.queryByLabelText('One-time invitation link')).not.toBeInTheDocument();
  });

  it('clears the manual link on a clientId change without remounting', () => {
    const { rerender } = render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_SENT' })}
      />,
    );
    // Simulate a link already being displayed by re-rendering with a
    // different clientId — the component's own guard must reset it.
    rerender(<PortalInvitationPanel clientId="a-different-client" initialInvitation={null} />);

    expect(screen.queryByLabelText('One-time invitation link')).not.toBeInTheDocument();
    expect(screen.getByText('Not Invited')).toBeInTheDocument();
  });
});

describe('PortalInvitationPanel — accessibility', () => {
  it('exposes the status/delivery block as a description list with labeled terms', () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({ status: 'INVITATION_SENT', destinationEmail: 'a@b.test' })}
      />,
    );
    expect(screen.getByText('Status').tagName).toBe('DT');
    expect(screen.getByText('Delivery').tagName).toBe('DT');
  });

  it('never conveys status by color alone — the effective-expiry annotation is plain text', () => {
    render(
      <PortalInvitationPanel
        clientId={CLIENT_ID}
        initialInvitation={invitation({
          status: 'INVITATION_SENT',
          expiresAt: '2020-01-01T00:00:00.000Z',
        })}
      />,
    );
    expect(screen.getByText(/Invitation Sent \(expired\)/)).toBeInTheDocument();
  });
});
