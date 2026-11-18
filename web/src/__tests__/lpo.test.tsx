import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { RfeLpoCard, MrLpoCard } from '@/components/ops/LpoCard';
import { LpoPendingList } from '@/pages/LpoPage';
import { ProcurementView } from '@/pages/ProcurementPage';
import type { Lpo, ProcurementSummary, WrDetail } from '@/lib/types';

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
};
afterEach(() => { vi.unstubAllGlobals(); });

const lpo = (over: Partial<Lpo> = {}): Lpo => ({
  id: 'l1', wrCode: '9200001', materialRequestId: null, mrCode: null, lpoNo: 'LPO-TEST-1', issueDate: '2026-11-05', vendorName: 'Test Vendor Co', vendorContact: null,
  approvedAmount: 1250.5, rfeAmountSnapshot: 1300, rfeApprovedOn: '2026-10-30', remarks: null, status: 'released', cancelledReason: null, createdByName: 'Pat Purchasing',
  createdAt: '2026-11-05T08:00:00Z', updatedAt: '2026-11-05T08:00:00Z', can: { edit: true },
  documents: [{ id: 'd1', fileName: 'lpo-test.pdf', mime: 'application/pdf', createdAt: '2026-11-05T08:01:00Z', uploadedByName: 'Pat Purchasing' }],
  history: [{ id: 'h1', action: 'created', changes: { lpoNo: { from: null, to: 'LPO-TEST-1' }, vendorName: { from: null, to: 'Test Vendor Co' } }, at: '2026-11-05T08:00:00Z', userName: 'Pat Purchasing' }],
  ...over,
});
const wr = {
  wrCode: '9200001', today: '2026-11-09', goneAt: null, materialRequests: [],
  rfe: { submittedOn: '2026-10-20', approvedOn: '2026-10-30', pendingWith: null, rfeAmount: 1300, bpaReleaseRef: 'BPA-TEST' },
  rfeComments: [{ id: 'c1', text: 'Confirm scope' }],
  rfeHistory: [{ at: '2026-10-20', kind: 'rfe_submitted', text: 'RFE submitted', source: 'marafiq', by: null }],
  lpos: [lpo()],
} as unknown as WrDetail;

describe('LPO on the work request page', () => {
  it('shows the RFE facts, the LPO with its document, and Add LPO for procurement', async () => {
    wrap(<RfeLpoCard wr={wr} role="purchasing" />);
    expect(screen.getByText('RFE & LPO')).toBeInTheDocument();
    expect(screen.getByText('BPA-TEST')).toBeInTheDocument();
    const item = screen.getByTestId('lpo-LPO-TEST-1');
    expect(within(item).getByText('Test Vendor Co')).toBeInTheDocument();
    expect(within(item).getByText(/1,250.5/)).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'lpo-test.pdf' })).toHaveAttribute('href', '/api/attachments/d1');
    expect(screen.getByRole('button', { name: /Add LPO/ })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    await userEvent.click(within(item).getByRole('button', { name: /History/ }));
    expect(within(item).getByText('LPO released')).toBeInTheDocument();
  });

  it('hides every edit button from a supervisor but still shows the LPO and its document', () => {
    wrap(<RfeLpoCard wr={{ ...wr, lpos: [lpo({ can: { edit: false } })] } as WrDetail} role="supervisor" />);
    expect(screen.getByText('LPO-TEST-1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'lpo-test.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add LPO/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel LPO/ })).toBeNull();
  });

  it('shows nothing for a work request without an RFE or LPO', () => {
    const { container } = wrap(<RfeLpoCard wr={{ ...wr, rfe: null, lpos: [] } as unknown as WrDetail} role="purchasing" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('LPO elsewhere', () => {
  it('the procurement dashboard has LPO Pending and LPO Released tiles', () => {
    const summary: ProcurementSummary = { new: 0, pending: 0, enquiry: 0, quoted: 0, ordered: 0, delivered: 0, closedThisMonth: 0, rejected: 0, overdue: 0, lpo: { pending: 3, releasedThisMonth: 1, released: 5 } };
    wrap(<ProcurementView data={summary} />);
    expect(within(screen.getByRole('button', { name: /LPO Pending/ })).getByTestId('kpi-value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LPO Released/ })).toBeInTheDocument();
    expect(screen.getByTestId('lpo-released-month')).toHaveTextContent('1 released this month');
  });

  it('the pending list links to the WR and offers Add LPO', () => {
    wrap(<LpoPendingList items={[{ wrCode: '9200001', buildingName: 'Test Building', description: 'Leaking tap', wrStatus: null, rfeAmount: 1300, approvedOn: '2026-10-30', daysSinceApproval: 10 }]} />);
    expect(screen.getByRole('link', { name: /WR 9200001/ })).toHaveAttribute('href', '/work-requests/9200001');
    expect(screen.getByText('10 days since approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add LPO for WR 9200001/ })).toBeInTheDocument();
  });

  it('the MR page lists its linked LPOs', () => {
    wrap(<MrLpoCard lpos={[lpo()]} />);
    expect(screen.getByRole('list', { name: 'Linked LPOs' })).toBeInTheDocument();
    expect(screen.getByText('LPO-TEST-1')).toBeInTheDocument();
  });
});
