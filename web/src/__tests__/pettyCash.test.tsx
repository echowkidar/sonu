import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { PettyCashDetailView } from '@/pages/PettyCashDetailPage';
import { PettyCashLineDialog, buildLineBody } from '@/components/ops/PettyCashLineDialog';
import { ProcurementView } from '@/pages/ProcurementPage';
import { ZeroRfeReportView } from '@/pages/ZeroRfeReportPage';
import { approvePayload, claimActions, claimTotal, lineTotal } from '@/lib/pettyCash';
import type { PettyCashDetail, PettyCashLine, ProcurementSummary, ZeroRfeReport } from '@/lib/types';

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
};
afterEach(() => { vi.unstubAllGlobals(); });

const line = (over: Partial<PettyCashLine> = {}): PettyCashLine => ({
  id: 'l1', lineNo: 1, workRequestId: 'w1', wrCode: '9100001', wrStatus: 'Assigned to Work Order', localPurchaseId: 'p1', grnCode: null, glCode: null, wbs: null,
  workDescription: 'Leaking tap', location: 'Test Building', rfeApprovedAmount: 0, claimable: true, supplier: 'Test Supplier', materialUsed: 'Mixer tap', billDate: '2026-11-03',
  billNo: 'B-1', qty: 1, unit: 'lot', unitCost: 30.25, discount: 0, totalAmount: 30.25, approvedTotal: null,
  receipts: [{ id: 'r1', fileName: 'receipt.png', mime: 'image/png', source: 'local_purchase' }], ...over,
});

const claim = (over: Partial<PettyCashDetail> = {}, can: Partial<PettyCashDetail['can']> = {}): PettyCashDetail => ({
  id: 'c1', refNo: 4, code: 'PC-4', status: 'draft', statusLabel: 'Draft', projectName: 'TD-TEST Project', month: '2026-11', purchaseType: 'materials', preparedBy: 'u1',
  preparedByName: 'Sam Supervisor', reviewedByName: null, reviewedAt: null, approvedByName: null, approvedAt: null, totalAmount: 42.25, approvedAmount: null,
  pending: { role: 'preparer', label: 'Sam Supervisor (to prepare and submit)' }, createdAt: '2026-11-08T08:00:00Z', updatedAt: '2026-11-08T08:00:00Z', preparedAt: null,
  lines: [line(), line({ id: 'l2', lineNo: 2, materialUsed: 'Seal kit', unitCost: 12, totalAmount: 12, localPurchaseId: null, receipts: [] })],
  history: [{ id: 'h1', fromStatus: null, toStatus: 'draft', note: null, at: '2026-11-08T08:00:00Z', userName: 'Sam Supervisor' }], unclaimedCount: 2,
  can: { edit: false, submit: false, review: false, return: false, approve: false, reject: false, importPurchases: false, export: true, role: 'purchasing', ...can }, ...over,
});

describe('petty cash maths', () => {
  it('line total is qty x unit cost - discount with 2 decimals and the claim total is the sum', () => {
    expect(lineTotal(3, 10.1, 0.5)).toBe(29.8);
    expect(lineTotal(1, 0.1 + 0.2, 0)).toBe(0.3);
    expect(lineTotal(2.5, 4, 0)).toBe(10);
    expect(claimTotal([{ totalAmount: 30.25 }, { totalAmount: 12 }, { totalAmount: 29.8 }])).toBe(72.05);
  });

  it('approve payload carries only the changed lines and a total only when it differs from the sum', () => {
    const lines = [{ id: 'a', totalAmount: 30.25 }, { id: 'b', totalAmount: 12 }];
    expect(approvePayload(lines, {}, null)).toEqual({ body: { action: 'approve' }, sum: 42.25 });
    expect(approvePayload(lines, { a: '20' }, null)).toEqual({ body: { action: 'approve', approvedAmounts: { a: 20 } }, sum: 32 });
    expect(approvePayload(lines, {}, '40').body).toEqual({ action: 'approve', approvedTotal: 40 });
    expect(approvePayload(lines, {}, '42.25').body).toEqual({ action: 'approve' });
  });

  it('line form validation', () => {
    const base = { wrCode: '', grnCode: '', glCode: '', wbs: '', workDescription: '', location: '', rfe: '', claimable: true, supplier: '', materialUsed: '', billDate: '', billNo: '', qty: '2', unit: 'pcs', unitCost: '5', discount: '' };
    expect(buildLineBody({ ...base, qty: '0' })).toEqual({ error: 'The quantity must be more than 0.' });
    expect(buildLineBody({ ...base, discount: '11' })).toEqual({ error: 'The discount cannot be more than quantity times unit cost.' });
    const ok = buildLineBody(base);
    expect('body' in ok && ok.body).toMatchObject({ qty: 2, unitCost: 5, discount: 0, wrCode: null, unit: 'pcs', claimable: true });
  });
});

describe('petty cash claim screen', () => {
  const buttons = () => screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');

  it('supervisor on a draft: submit, import and add line; lines show as cards with receipts', () => {
    wrap(<PettyCashDetailView claim={claim({}, { edit: true, submit: true, importPurchases: true, role: 'supervisor' })} role="supervisor" userId="u1" />);
    expect(screen.getByRole('button', { name: /Submit for review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add unclaimed local purchases \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add line/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export Excel/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Review and forward/ })).toBeNull();
    expect(screen.getByTestId('claim-total')).toHaveTextContent('QR 42.25');
    expect(screen.getByLabelText('Claim lines').children).toHaveLength(2);
    expect(screen.getByAltText('Receipt for line 1')).toBeInTheDocument();
    expect(screen.getByTestId('pending')).toHaveTextContent('Sam Supervisor');
    expect(screen.getByRole('button', { name: 'Edit line 1' })).toBeInTheDocument();
  });

  it('admin on a submitted claim reviews or returns; manager approves or rejects; purchasing only exports', () => {
    const { unmount } = wrap(<PettyCashDetailView claim={claim({ status: 'submitted' }, { review: true, return: true, role: 'contractor_admin' })} role="contractor_admin" userId="a1" />);
    expect(buttons()).toEqual(expect.arrayContaining(['Review and forward to Manager', 'Return to preparer', 'Export Excel']));
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add line/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit line 1' })).toBeNull();
    unmount();
    const m = wrap(<PettyCashDetailView claim={claim({ status: 'reviewed' }, { approve: true, reject: true, role: 'manager' })} role="manager" userId="m1" />);
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review and forward/ })).toBeNull();
    m.unmount();
    wrap(<PettyCashDetailView claim={claim({ status: 'submitted' })} role="purchasing" userId="p1" />);
    expect(buttons().filter((b) => /Submit|Review|Return|Approve|Reject|Add/.test(b))).toEqual([]);
    expect(screen.getByRole('button', { name: /Export Excel/ })).toBeInTheDocument();
  });

  it('claimActions follows the server flags', () => {
    expect(claimActions(claim({}, { submit: true }).can)).toEqual(['submit']);
    expect(claimActions(claim({}, { review: true, return: true }).can)).toEqual(['review', 'return']);
    expect(claimActions(claim({}, {}).can)).toEqual([]);
  });

  it('manager approves with an adjusted line amount and the request carries it', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(claim({ status: 'approved', approvedAmount: 32 })), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const user = userEvent.setup();
    wrap(<PettyCashDetailView claim={claim({ status: 'reviewed' }, { approve: true, reject: true, role: 'manager' })} role="manager" userId="m1" />);
    await user.click(screen.getByRole('button', { name: /^Approve$/ }));
    const dlg = await screen.findByRole('dialog');
    const first = within(dlg).getByLabelText(/Line 1/);
    await user.clear(first);
    await user.type(first, '20');
    expect(within(dlg).getByLabelText(/Final approved amount/)).toHaveValue(32);
    await user.click(within(dlg).getByRole('button', { name: 'Approve claim' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ action: 'approve', approvedAmounts: { l1: 20 } });
  });

  it('return needs a note', async () => {
    const user = userEvent.setup();
    wrap(<PettyCashDetailView claim={claim({ status: 'submitted' }, { review: true, return: true, role: 'contractor_admin' })} role="contractor_admin" userId="a1" />);
    await user.click(screen.getByRole('button', { name: /Return to preparer/ }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Return claim' }));
    expect(await within(dlg).findByText('Say what the preparer must fix.')).toBeInTheDocument();
  });

  it('line dialog shows the live total', async () => {
    const user = userEvent.setup();
    wrap(<PettyCashLineDialog claimId="c1" open onOpenChange={() => undefined} onSaved={() => undefined} />);
    await user.clear(screen.getByLabelText('Qty'));
    await user.type(screen.getByLabelText('Qty'), '3');
    await user.type(screen.getByLabelText(/Unit cost/), '10.1');
    await user.type(screen.getByLabelText(/Discount/), '0.5');
    expect(screen.getByTestId('line-total')).toHaveTextContent('QR 29.80');
  });
});

describe('petty cash tiles and 0 RFE links', () => {
  const base: ProcurementSummary = { new: 0, pending: 0, enquiry: 0, quoted: 0, ordered: 0, delivered: 0, closedThisMonth: 0, rejected: 0, overdue: 0 };

  it('procurement shows the three petty cash tiles only when the summary has them', () => {
    const { unmount } = wrap(<ProcurementView data={base} />);
    expect(screen.queryByText('Petty Cash Claims')).toBeNull();
    unmount();
    wrap(<ProcurementView data={{ ...base, pettyCash: { draft: 1, pendingReview: 2, pendingApproval: 1, approved: 3, rejected: 1, approvedAmountThisMonth: 120.5 } }} />);
    expect(screen.getByText('Petty Cash Claims')).toBeInTheDocument();
    expect(screen.getByText('Petty Cash Pending Approval')).toBeInTheDocument();
    expect(screen.getByText('Approved / Rejected Claims')).toBeInTheDocument();
    expect(screen.getByTestId('petty-cash-approved')).toHaveTextContent('QR 120.50');
  });

  it('the 0 RFE report says whether purchases are on a claim', () => {
    const item = { wrCode: '9100001', buildingName: 'B', description: 'D', zone: null, discipline: null, convertedAt: '2026-11-02', convertedByName: 'Sam', expected: 40, spent: 42, purchases: 2, receipts: 2, wrStatus: null, qfStageLabel: '6. In Progress' };
    const data: ZeroRfeReport = {
      month: '2026-11', totals: { jobs: 2, expected: 80, spent: 42, withoutReceipt: 0 },
      items: [{ ...item, claimed: 2, claims: [{ id: 'c1', code: 'PC-4', status: 'approved' }] }, { ...item, wrCode: '9100002', claimed: 0, claims: [] }],
    };
    wrap(<ZeroRfeReportView data={data} />);
    expect(screen.getByTestId('claim-9100001')).toHaveTextContent('PC-4 (Approved)');
    expect(screen.getByTestId('claim-9100002')).toHaveTextContent('Not claimed yet');
  });
});
