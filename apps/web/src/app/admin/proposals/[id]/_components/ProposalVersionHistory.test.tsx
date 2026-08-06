// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));
// PublishProposalVersionButton (rendered per eligible draft when
// `canPublish` is true, Stage 7E) calls useRouter() — every existing test
// below passes `canPublish={false}`, so the button (and this mock) is never
// exercised by them; only the new "Publish action" tests below need it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import type { ProposalVersionEntry } from './ProposalVersionHistory';
import { ProposalVersionHistory } from './ProposalVersionHistory';

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
  pushMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function version(overrides: Partial<ProposalVersionEntry> = {}): ProposalVersionEntry {
  return {
    id: 'version-1',
    proposalId: 'proposal-1',
    versionNumber: 1,
    content: 'Sample proposal content.',
    clientVisibleAt: null,
    supersededAt: null,
    createdByUserId: 'tc-1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    acceptance: null,
    ...overrides,
  };
}

describe('ProposalVersionHistory', () => {
  it('identifies the latest version as the first item supplied, without recomputing an order', () => {
    render(
      <ProposalVersionHistory
        versions={[
          version({ id: 'v2', versionNumber: 2 }),
          version({ id: 'v1', versionNumber: 1 }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    const latestRow = screen.getByText('Latest version').closest('div');
    expect(latestRow).not.toBeNull();
    expect(within(latestRow as HTMLElement).getByText('Version 2')).toBeInTheDocument();
  });

  it('renders "No published version yet." when no version is current client-visible', () => {
    render(
      <ProposalVersionHistory
        versions={[
          version({ id: 'v1', versionNumber: 1, clientVisibleAt: null, supersededAt: null }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    const publishedRow = screen.getByText('Published version').closest('div');
    expect(
      within(publishedRow as HTMLElement).getByText('No published version yet.'),
    ).toBeInTheDocument();
  });

  it('identifies the published version distinctly from a newer, still-unpublished latest version', () => {
    render(
      <ProposalVersionHistory
        versions={[
          version({
            id: 'v2',
            versionNumber: 2,
            clientVisibleAt: null,
            supersededAt: null,
          }),
          version({
            id: 'v1',
            versionNumber: 1,
            clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
            supersededAt: null,
          }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    const latestRow = screen.getByText('Latest version').closest('div');
    expect(within(latestRow as HTMLElement).getByText('Version 2')).toBeInTheDocument();

    const publishedRow = screen.getByText('Published version').closest('div');
    expect(within(publishedRow as HTMLElement).getByText('Version 1')).toBeInTheDocument();
  });

  describe('Lifecycle state (Draft / Published / Superseded)', () => {
    it('labels an unpublished draft as Draft', () => {
      render(
        <ProposalVersionHistory
          versions={[version({ clientVisibleAt: null, supersededAt: null })]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Lifecycle: Draft')).toBeInTheDocument();
    });

    it('labels the current client-visible version as Published', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ clientVisibleAt: new Date('2026-08-01T00:00:00Z'), supersededAt: null }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Lifecycle: Published')).toBeInTheDocument();
    });

    it('labels a superseded version as Superseded, regardless of clientVisibleAt', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: new Date('2026-08-02T00:00:00Z'),
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Lifecycle: Superseded')).toBeInTheDocument();
    });
  });

  describe('Response state (No response / Accepted / Declined / Changes requested)', () => {
    it('labels a version with no recorded response as "No response"', () => {
      render(
        <ProposalVersionHistory
          versions={[version({ acceptance: null })]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Response: No response')).toBeInTheDocument();
    });

    it('labels an ACCEPT response as Accepted', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'version-1',
                responseType: 'ACCEPT',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'Phone',
                evidenceReference: 'call-log-123',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Response: Accepted')).toBeInTheDocument();
    });

    it('labels a DECLINE response as Declined', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'version-1',
                responseType: 'DECLINE',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'Email',
                evidenceReference: 'email-thread-9',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Response: Declined')).toBeInTheDocument();
    });

    it('labels a REQUEST_CHANGES response as "Changes requested"', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'version-1',
                responseType: 'REQUEST_CHANGES',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'In person',
                evidenceReference: 'meeting-notes-4',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Response: Changes requested')).toBeInTheDocument();
    });

    it('renders lifecycle and response as two separate labels, never collapsed into one', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: new Date('2026-08-03T00:00:00Z'),
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'version-1',
                responseType: 'ACCEPT',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'Phone',
                evidenceReference: 'call-log-123',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );

      // "Lifecycle: Superseded" and "Response: Accepted" are each a complete,
      // separately labeled indicator — found as two distinct DOM elements,
      // never merged into one combined badge or string.
      const lifecycleBadge = screen.getByText('Lifecycle: Superseded');
      const responseBadge = screen.getByText('Response: Accepted');
      expect(lifecycleBadge).toBeInTheDocument();
      expect(responseBadge).toBeInTheDocument();
      expect(lifecycleBadge).not.toBe(responseBadge);
      expect(
        screen.queryByText('Lifecycle: Superseded, Response: Accepted'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Superseded, Accepted')).not.toBeInTheDocument();
      expect(screen.queryByText('Accepted, Superseded')).not.toBeInTheDocument();
    });
  });

  describe('Content rendering (plain text only, never HTML/Markdown interpretation)', () => {
    it('renders content as literal plain text, never executing or interpreting markup', () => {
      const markupLikeContent = '<script>window.__xss = true;</script> plain text stays plain';
      render(
        <ProposalVersionHistory
          versions={[version({ content: markupLikeContent })]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );

      expect(screen.getByText(markupLikeContent)).toBeInTheDocument();
      expect(document.querySelector('script')).not.toBeInTheDocument();
      expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    });

    it('renders "Content unavailable" for a null (legacy) content value', () => {
      render(
        <ProposalVersionHistory
          versions={[version({ content: null })]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Content unavailable')).toBeInTheDocument();
    });

    it('renders "Content unavailable" for an empty-string content value', () => {
      render(
        <ProposalVersionHistory
          versions={[version({ content: '' })]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );
      expect(screen.getByText('Content unavailable')).toBeInTheDocument();
    });
  });

  it('shows the creation timestamp and the raw createdByUserId for each version', () => {
    render(
      <ProposalVersionHistory
        versions={[
          version({
            createdByUserId: 'tc-42',
            createdAt: new Date('2026-08-01T00:00:00Z'),
          }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    expect(screen.getByText('tc-42')).toBeInTheDocument();
    const expectedLabel = new Date('2026-08-01T00:00:00Z').toLocaleString('en-PH');
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it('renders items in exactly the order supplied, without reordering', () => {
    const { container } = render(
      <ProposalVersionHistory
        versions={[
          version({ id: 'v1', versionNumber: 1 }),
          version({ id: 'v3', versionNumber: 3 }),
          version({ id: 'v2', versionNumber: 2 }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    const headings = Array.from(container.querySelectorAll('ol > li > h3')).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(['Version 1', 'Version 3', 'Version 2']);
  });

  it('renders "No versions yet." when the versions array is empty', () => {
    render(<ProposalVersionHistory versions={[]} canPublish={false} canRecordResponse={false} />);

    expect(screen.getAllByText('No versions yet.').length).toBeGreaterThan(0);
    expect(screen.getByText('No published version yet.')).toBeInTheDocument();
  });

  it('exposes a semantic ordered list of version entries', () => {
    const { container } = render(
      <ProposalVersionHistory
        versions={[
          version({ id: 'v1', versionNumber: 1 }),
          version({ id: 'v2', versionNumber: 2 }),
        ]}
        canPublish={false}
        canRecordResponse={false}
      />,
    );

    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll(':scope > li').length).toBe(2);
  });

  describe('Publish action (D-027 §5, Stage 7E)', () => {
    it('renders a publish button for an eligible draft when canPublish is true', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v2', versionNumber: 2, clientVisibleAt: null, supersededAt: null }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      expect(screen.getByRole('button', { name: 'Publish Version 2' })).toBeInTheDocument();
    });

    it('renders no publish button when canPublish is false, even for an eligible draft', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v2', versionNumber: 2, clientVisibleAt: null, supersededAt: null }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });

    it('renders no publish button for the current client-visible version', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });

    it('renders no publish button for a superseded version, regardless of clientVisibleAt', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: new Date('2026-08-02T00:00:00Z'),
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });

    it('renders a correctly labelled publish action for each of multiple eligible drafts, and none for the current published version', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v3', versionNumber: 3, clientVisibleAt: null, supersededAt: null }),
            version({ id: 'v2', versionNumber: 2, clientVisibleAt: null, supersededAt: null }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      expect(screen.getByRole('button', { name: 'Publish Version 3' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Publish Version 2' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish Version 1' })).not.toBeInTheDocument();
    });

    it("sends the observed current published version id — not the newer draft's own id — as expectedCurrentVersionId", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: 'v3' } }));
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v3', versionNumber: 3, clientVisibleAt: null, supersededAt: null }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 3' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/proposals/versions/v3/publish',
          expect.anything(),
        ),
      );
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.expectedCurrentVersionId).toBe('v1');
    });

    it('sends an explicit null expectedCurrentVersionId when no version is currently client-visible', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: 'v1' } }));
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v1', versionNumber: 1, clientVisibleAt: null, supersededAt: null }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      await userEvent.setup().click(screen.getByRole('button', { name: 'Publish Version 1' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toHaveProperty('expectedCurrentVersionId');
      expect(body.expectedCurrentVersionId).toBeNull();
    });

    it('does not prevent publishing a later draft even when the current version has already been Accepted', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v2', versionNumber: 2, clientVisibleAt: null, supersededAt: null }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'v1',
                responseType: 'ACCEPT',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'Phone',
                evidenceReference: 'call-log-123',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      const publishButton = screen.getByRole('button', { name: 'Publish Version 2' });
      expect(publishButton).toBeInTheDocument();
      expect(publishButton).not.toBeDisabled();
    });

    it('renders no Accept, Decline, Request Changes, or response-recording control', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({ id: 'v2', versionNumber: 2, clientVisibleAt: null, supersededAt: null }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
            }),
          ]}
          canPublish={true}
          canRecordResponse={false}
        />,
      );

      expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^decline$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/response method/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/evidence reference/i)).not.toBeInTheDocument();
    });
  });

  describe('Response-recording action (D-027 §7/§9.1, Stage 7F)', () => {
    it('renders no response form when canRecordResponse is false, even for the current client-visible version', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={false}
        />,
      );

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('renders exactly one response form for the current client-visible unresponded version', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(screen.getAllByRole('heading', { name: 'Record Client Response' })).toHaveLength(1);
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
    });

    it('never renders the response form for a draft', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: null,
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('never renders the response form for a superseded version, regardless of clientVisibleAt', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: new Date('2026-08-02T00:00:00Z'),
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('never renders the response form for a version that already has a recorded response', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: {
                id: 'acc-1',
                proposalVersionId: 'v1',
                responseType: 'ACCEPT',
                respondedAt: new Date('2026-08-02T00:00:00Z'),
                recordedByStaffUserId: 'tc-1',
                responseMethod: 'Phone',
                evidenceReference: 'call-log-123',
                createdAt: new Date('2026-08-02T00:00:00Z'),
              },
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('keeps the response form on the older current version even when a newer unpublished draft coexists', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v2',
              versionNumber: 2,
              clientVisibleAt: null,
              supersededAt: null,
              acceptance: null,
            }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(screen.getAllByRole('heading', { name: 'Record Client Response' })).toHaveLength(1);
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Record Response for Version 2' }),
      ).not.toBeInTheDocument();
    });

    it('passes the exact target version id and version number to the panel', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: 'v42' } }),
      );
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v42',
              versionNumber: 7,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      const button = screen.getByRole('button', { name: 'Record Response for Version 7' });
      expect(button).toBeInTheDocument();

      // Fills in a minimum valid form and submits — proving the exact
      // target version id (not merely a label string) reaches the panel
      // and is what gets submitted to the endpoint.
      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), {
        target: { value: 'Phone' },
      });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #123' },
      });
      await userEvent.setup().click(button);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/proposals/versions/v42/response',
          expect.anything(),
        ),
      );
    });

    it('preserves existing publishing eligibility unchanged alongside response-recording eligibility', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v2',
              versionNumber: 2,
              clientVisibleAt: null,
              supersededAt: null,
              acceptance: null,
            }),
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={true}
          canRecordResponse={true}
        />,
      );

      expect(screen.getByRole('button', { name: 'Publish Version 2' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish Version 1' })).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Record Response for Version 2' }),
      ).not.toBeInTheDocument();
    });

    it('preserves existing lifecycle and response badge rendering unchanged alongside the response form', () => {
      render(
        <ProposalVersionHistory
          versions={[
            version({
              id: 'v1',
              versionNumber: 1,
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              acceptance: null,
            }),
          ]}
          canPublish={false}
          canRecordResponse={true}
        />,
      );

      expect(screen.getByText('Lifecycle: Published')).toBeInTheDocument();
      expect(screen.getByText('Response: No response')).toBeInTheDocument();
    });
  });
});
