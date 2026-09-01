// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ActivationForm } from './ActivationForm';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';
const VALID_PASSWORD = 'correct-horse-battery';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let replaceMock: ReturnType<typeof vi.fn>;
let replaceStateSpy: ReturnType<typeof vi.spyOn>;

const originalLocation = window.location;

// D-038 Section 4: the token now travels in `window.location.hash`, never
// `.pathname`. jsdom's real `Location.prototype.replace` is not
// configurable, so `vi.spyOn(window.location, 'replace')` cannot redefine
// it directly — replace the whole `window.location` with a plain object
// carrying only what this component reads (`hash`, `pathname`) and calls
// (`replace`), mirroring the pre-D-038 test's own established technique.
function setLocationHash(hash: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hash, pathname: '/activate', replace: replaceMock },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  replaceMock = vi.fn();
  setLocationHash(`#token=${VALID_TOKEN}`);
  // `window.history.replaceState` is a normal, configurable method in
  // jsdom (unlike `location.replace`) — spy on it directly rather than
  // replacing the whole `window.history` object.
  replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('ActivationForm — not-opened state', () => {
  it('renders a Continue button, never the password form, and posts the fragment-derived token on click', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    render(<ActivationForm />);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/activation/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: VALID_TOKEN }),
      }),
    );
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('renders the generic invalid message when Continue is rejected', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'ACTIVATION_NOT_POSSIBLE' } }),
    );
    const user = userEvent.setup();
    render(<ActivationForm />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('renders the generic invalid message when the fragment is missing, never issuing a request', async () => {
    setLocationHash('');
    const user = userEvent.setup();
    render(<ActivationForm />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the generic invalid message when the fragment is malformed, never issuing a request', async () => {
    setLocationHash('#token=not-24-characters');
    const user = userEvent.setup();
    render(<ActivationForm />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reads the fragment on initial render — no request is ever issued automatically on mount', () => {
    render(<ActivationForm />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a second Continue click while the first request is in flight', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<ActivationForm />);

    const button = screen.getByRole('button', { name: 'Continue' });
    await user.click(button);
    await user.click(button);
    await user.click(button);

    resolveFetch(jsonResponse(200, { opened: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('stays in the Continue state (never invalid) on a 429 rate-limit rejection, so the user can retry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many attempts.' } }),
    );
    const user = userEvent.setup();
    render(<ActivationForm />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(screen.queryByText('This invitation link is no longer valid.')).not.toBeInTheDocument();
    // The fragment must not have been cleared — a retry can still read it.
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});

describe('ActivationForm — opened state', () => {
  it('renders the password form directly, with accessible labels and autocomplete', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    const password = screen.getByLabelText('Password');
    const confirm = screen.getByLabelText('Confirm password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'new-password');
    expect(confirm).toHaveAttribute('type', 'password');
  });

  it('submits the fragment-derived token and entered password, redirecting with replace semantics on success', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { opened: true }))
      .mockResolvedValueOnce(jsonResponse(200, { activated: true }));
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/activation/activate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: VALID_TOKEN,
          password: VALID_PASSWORD,
          confirmPassword: VALID_PASSWORD,
        }),
      }),
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login?activated=1'));
  });

  it('renders field-level password errors from a 400 response and preserves the submitted value', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true })).mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          details: [{ path: 'password', message: 'Password must be at least 12 characters.' }],
        },
      }),
    );
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    await user.type(screen.getByLabelText('Password'), 'short1');
    await user.type(screen.getByLabelText('Confirm password'), 'short1');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('short1');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders the identical generic invalid message on a 409 rejection', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { opened: true }))
      .mockResolvedValueOnce(jsonResponse(409, { error: { code: 'ACTIVATION_NOT_POSSIBLE' } }));
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('stays in the opened/password-form state on a 429 rate-limit rejection, preserving the entered password', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { opened: true }))
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many attempts.' } }),
      );
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() => expect(screen.getByLabelText('Password')).toBeEnabled());
    expect(screen.getByLabelText('Password')).toHaveValue(VALID_PASSWORD);
    expect(screen.queryByText('This invitation link is no longer valid.')).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
    // The fragment must not have been cleared — a retry can still read it.
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('disables the submit control while submitting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(screen.getByRole('button', { name: 'Activating…' })).toBeDisabled();
    resolveFetch(jsonResponse(200, { activated: true }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });
});

describe('ActivationForm — token security', () => {
  it('never renders the raw token anywhere in the DOM, in either state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    const { container, unmount } = render(<ActivationForm />);
    expect(container.innerHTML).not.toContain(VALID_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');
    expect(container.innerHTML).not.toContain(VALID_TOKEN);
    unmount();
  });

  it('never includes the token in any DOM attribute', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    const { container } = render(<ActivationForm />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    const allAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes).map((attr) => attr.value),
    );
    expect(allAttributeValues.some((value) => value.includes(VALID_TOKEN))).toBe(false);
  });
});
