import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { MrFormView } from '@/components/ops/MrForm';
import { MaterialRequestsCard } from '@/components/ops/MrCard';
import { MrDetailView } from '@/pages/MrDetailPage';
import { ProcurementView } from '@/pages/ProcurementPage';
import { MrListView } from '@/pages/MrListPage';
import type { MrDetail, MrListItem, ProcurementSummary, WrDetail } from '@/lib/types';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function mockFetch(reply: (url: string, method: string) => unknown = () => ({})) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null });
    return new Response(JSON.stringify(reply(url, method)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

const Where = () => <p data-testid="where">{useLocation().pathname}{useLocation().search}</p>;
const wrap = (ui: React.ReactElement, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { calls = []; });

const wr = {
  wrCode: '9100001', today: '2026-11-09', buildingName: 'Test Building', goneAt: null,
  computed: { facility: 'North Facility', zone: 'Zone 2', discipline: 'MEP' },
  materialRequests: [{ id: 'm1', mrNo: 1, mrCode: 'MR-1', status: 'quoted', dateRequested: '2026-11-08', lines: 2, requestedByName: 'Fay Foreman' }],
} as unknown as WrDetail;

const mr = (over: Partial<MrDetail> = {}): MrDetail => ({
  id: 'm1', mrNo: 1, mrCode: 'MR-1', status: 'submitted', statusLabel: 'New', wrCode: '9100001', dateRequested: '2026-11-08', projectName: 'Test Project', contractNo: 'C-TEST-1',
  itemDiscipline: 'MEP', facility: 'North Facility', zone: 'Zone 2', buildingName: 'Test Building', purchaseType: 'materials', purpose: 'new', additionalRequirements: 'Deliver to store',
  docsRequired: ['quote'], requestedBy: 'u-req', requestedByName: 'Fay Foreman', assignedTo: null, assignedToName: null, vendorName: null, vendorContact: null, quotationRef: null,
  quotedAmount: null, expectedDelivery: null, procurementRemarks: null, createdAt: '2026-11-08T08:00:00Z', updatedAt: '2026-11-08T08:00:00Z', closedAt: null,
  lines: [
    { id: 'l1', lineNo: 1, wrCode: '9100001', storeSlNo: null, clientMatRef: null, description: 'Ball valve 1 inch', quantity: 2, uom: 'pcs', brand: 'Acme', kind: 'material', vendorOrigin: 'local', claimable: true, targetDate: '2026-11-20', remarks: null, photos: [] },
  ],
  history: [{ id: 'h1', fromStatus: null, toStatus: 'submitted', note: null, at: '2026-11-08T08:00:00Z', userName: 'Fay Foreman' }],
  documents: [],
  can: { edit: false, cancel: false, procure: false, upload: false, nextStatuses: [] },
  ...over,
});

describe('material request form', () => {
  it('prefills the header from the work request and adds and removes lines', async () => {
    wrap(<MrFormView wr={wr} />);
    expect(screen.getByLabelText('Work request (WR number)')).toHaveValue('9100001');
    expect(screen.getByLabelText('Date requested')).toHaveValue('2026-11-09');
    expect(screen.getByLabelText('Facility')).toHaveValue('North Facility');
    expect(screen.getByLabelText('Zone')).toHaveValue('Zone 2');
    expect(screen.getByLabelText('Item discipline')).toHaveValue('MEP');
    expect(screen.getByLabelText('Building')).toHaveValue('Test Building');
    expect(screen.getAllByTestId('mr-line')).toHaveLength(1);
    // the only line cannot be removed
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Add line/ }));
    await userEvent.click(screen.getByRole('button', { name: /Add line/ }));
    expect(screen.getAllByTestId('mr-line')).toHaveLength(3);
    await userEvent.type(screen.getByLabelText('Material / service description (line 2)'), 'PTFE tape');
    await userEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(screen.getAllByTestId('mr-line')).toHaveLength(2);
    // numbering follows the order; the typed line is now line 1
    expect(screen.getByLabelText('Material / service description (line 1)')).toHaveValue('PTFE tape');
  });

  it('refuses a line without description or quantity and posts the request otherwise', async () => {
    mockFetch(() => ({ id: 'new1', mrCode: 'MR-7', wrCode: '9100001', lines: [{ id: 'nl1' }] }));
    wrap(<MrFormView wr={wr} />, '/procurement/mr/new?wr=9100001');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1: describe the item.');
    expect(calls).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Material / service description (line 1)'), 'Ball valve');
    await userEvent.clear(screen.getByLabelText('Qty'));
    await userEvent.type(screen.getByLabelText('Qty'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('enter a quantity more than 0');

    await userEvent.clear(screen.getByLabelText('Qty'));
    await userEvent.type(screen.getByLabelText('Qty'), '4');
    await userEvent.click(screen.getByLabelText('Services'));
    await userEvent.click(screen.getByLabelText('Quote'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/mr');
    expect(post.body).toMatchObject({
      wrCode: '9100001', purchaseType: 'services', purpose: 'new', docsRequired: ['quote'],
      lines: [{ description: 'Ball valve', quantity: 4, kind: 'service', vendorOrigin: null, claimable: null, targetDate: null }],
    });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/procurement/mr/new1'));
  });
});

describe('procurement dashboard', () => {
  const summary: ProcurementSummary = { new: 3, pending: 2, enquiry: 1, quoted: 4, ordered: 5, delivered: 6, closedThisMonth: 9, rejected: 7, overdue: 8 };

  it('shows one tile per section and each opens the filtered list', async () => {
    wrap(<ProcurementView data={summary} />, '/procurement');
    const tiles: [string, string, string][] = [
      ['New Material Requests', '3', '?status=submitted'], ['Pending Material Requests', '2', '?status=accepted'], ['Vendor Enquiries', '1', '?status=enquiry'],
      ['Quotations Received', '4', '?status=quoted'], ['Materials Ordered', '5', '?status=ordered'], ['Materials Delivered', '6', '?status=delivered'],
      ['Rejected', '7', '?status=rejected'], ['Overdue', '8', '?overdue=1'],
    ];
    for (const [label, value, search] of tiles) {
      const tile = screen.getByRole('button', { name: new RegExp(label) });
      await waitFor(() => expect(within(tile).getByTestId('kpi-value')).toHaveTextContent(value));
      await userEvent.click(tile);
      expect(screen.getByTestId('where')).toHaveTextContent(`/procurement/mr${search}`);
    }
    expect(screen.getByTestId('closed-this-month')).toHaveTextContent('9 closed this month');
  });
});

describe('material request list and work request card', () => {
  const item: MrListItem = {
    id: 'm1', mrNo: 12, mrCode: 'MR-12', status: 'enquiry', statusLabel: 'Vendor enquiry sent', wrCode: '9100005', dateRequested: '2026-11-08', purchaseType: 'materials', purpose: 'new',
    lines: 3, firstDescription: 'Ball valve', facility: null, buildingName: 'Test Building', requestedByName: 'Fay Foreman', assignedToName: null, vendorName: 'Test Vendor', quotedAmount: 100,
    expectedDelivery: null, overdue: true, updatedAt: '2026-11-08T08:00:00Z',
  };

  it('lists requests with status, overdue flag and a link to the request', () => {
    wrap(<MrListView items={[item]} />);
    const link = screen.getByRole('link', { name: /MR-12/ });
    expect(link).toHaveAttribute('href', '/procurement/mr/m1');
    expect(within(link).getByText('Vendor enquiry sent')).toBeInTheDocument();
    expect(within(link).getByText('Overdue')).toBeInTheDocument();
    expect(within(link).getByText(/Ball valve \+2 more/)).toBeInTheDocument();
  });

  it('the WR page card lists the MRs and offers "Raise MR" to field roles only', () => {
    const a = wrap(<MaterialRequestsCard wr={wr} role="foreman" />);
    expect(screen.getByRole('link', { name: /MR-1/ })).toHaveAttribute('href', '/procurement/mr/m1');
    expect(screen.getByText('Quotation received')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Raise MR/ })).toHaveAttribute('href', '/procurement/mr/new?wr=9100001');
    a.unmount();
    wrap(<MaterialRequestsCard wr={wr} role="purchasing" />);
    expect(screen.getByText('MR-1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Raise MR/ })).toBeNull();
  });
});

describe('material request page', () => {
  it('looks like the paper form and gives the requester Edit and Cancel while it is new', async () => {
    mockFetch(() => mr({ status: 'cancelled' }));
    wrap(<MrDetailView mr={mr({ can: { edit: true, cancel: true, procure: false, upload: true, nextStatuses: ['cancelled'] } })} role="foreman" userId="u-req" />);
    const header = screen.getByRole('list', { name: 'Progress' });
    expect(within(header).getAllByRole('listitem')).toHaveLength(7);
    expect(within(header).getByText('New').closest('li')).toHaveAttribute('aria-current', 'step');
    const dl = screen.getByLabelText('Request header');
    expect(within(dl).getByText('Test Project')).toBeInTheDocument();
    expect(within(dl).getByLabelText('Materials: yes')).toBeInTheDocument();
    expect(within(dl).getByLabelText('Services: no')).toBeInTheDocument();
    expect(within(dl).getByLabelText('Quote: yes')).toBeInTheDocument();
    expect(within(dl).getByLabelText('Warranty: no')).toBeInTheDocument();
    expect(screen.getAllByText('Ball valve 1 inch').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Edit/ })).toHaveAttribute('href', '/procurement/mr/m1/edit');
    expect(screen.queryByRole('group', { name: 'Move this request' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mr/m1/status' && (c.body as { to: string }).to === 'cancelled')).toBe(true));
  });

  it('gives procurement the accept / status / vendor panel, and requires a note to reject', async () => {
    mockFetch(() => mr({ status: 'accepted' }));
    const people = [{ id: 'p1', fullName: 'Pat Purchasing', role: 'purchasing', workTeams: [] }, { id: 'f1', fullName: 'Fay Foreman', role: 'foreman', workTeams: [] }];
    wrap(<MrDetailView mr={mr({ can: { edit: false, cancel: false, procure: true, upload: true, nextStatuses: ['accepted', 'enquiry', 'quoted', 'ordered', 'delivered', 'rejected'] } })} role="purchasing" userId="p1" people={people} />);
    const panel = screen.getByRole('group', { name: 'Move this request' });
    // assignee choices are procurement people only
    const assigned = screen.getByLabelText('Assigned to');
    expect(within(assigned).queryByText('Fay Foreman')).toBeNull();
    expect(within(assigned).getByText('Pat Purchasing')).toBeInTheDocument();

    await userEvent.selectOptions(within(panel).getByLabelText('Move to'), 'rejected');
    await userEvent.click(within(panel).getByRole('button', { name: 'Update status' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Say why the request is rejected.');
    expect(calls).toHaveLength(0);

    await userEvent.click(within(panel).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/mr/m1/status')?.body).toEqual({ to: 'accepted' }));

    await userEvent.type(screen.getByLabelText('Vendor'), 'Test Vendor LLC');
    await userEvent.type(screen.getByLabelText('Quoted amount (QR)'), '1250.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/mr/m1/procurement')?.body).toMatchObject({ vendorName: 'Test Vendor LLC', quotedAmount: 1250.5, assignedTo: null }));
  });

  it('shows the requester only a read-only procurement summary', () => {
    wrap(<MrDetailView mr={mr({ status: 'quoted', vendorName: 'Test Vendor LLC', quotedAmount: 99.5, can: { edit: false, cancel: false, procure: false, upload: true, nextStatuses: [] } })} role="foreman" userId="u-req" />);
    expect(screen.queryByLabelText('Vendor')).toBeNull();
    expect(screen.getByText('Test Vendor LLC')).toBeInTheDocument();
    expect(screen.getByText('QR 99.5')).toBeInTheDocument();
  });
});
