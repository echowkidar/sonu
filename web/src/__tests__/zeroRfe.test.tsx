import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SonuPanel } from '@/components/ops/SonuPanel';
import { LocalPurchasesCard } from '@/components/ops/ZeroRfe';
import { DashboardView } from '@/pages/DashboardPage';
import { ZeroRfeReportView } from '@/pages/ZeroRfeReportPage';
import type { DashboardData, Meta, WrDetail, ZeroRfeReport } from '@/lib/types';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function mockFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({ url, method: init?.method ?? 'GET', body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
};

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { calls = []; });

const base = {
  wrCode: '1234567', wrStatus: 'Assigned to Work Order', goneAt: null, today: '2026-11-09', rfe: null, localPurchases: [],
  internal: { ownerId: 'u1', ownerName: 'Sam Supervisor', criterion: 3, contractorStatus: null, fcRemarks: null, statusSource: null, dueAt: null, breachLevel: null, zeroRfe: null },
  suggestedStatus: null,
} as unknown as WrDetail;
const meta = { contractorStatuses: [], criteria: [], people: [] } as unknown as Meta;
const convertedInternal = { ...base.internal, zeroRfe: { at: '2026-11-09T08:00:00Z', byName: 'Sam Supervisor', amount: 45.5, note: null } };

describe('0 RFE', () => {
  it('offers "Convert to 0 RFE" to the owning supervisor and a coordinator, not to a non-owner or a foreman', () => {
    const a = wrap(<SonuPanel wr={base} meta={meta} role="supervisor" userId="u1" />);
    expect(screen.getByRole('button', { name: /Convert to 0 RFE/ })).toBeInTheDocument();
    a.unmount();
    const b = wrap(<SonuPanel wr={base} meta={meta} role="supervisor" userId="u2" />);
    expect(screen.queryByRole('button', { name: /Convert to 0 RFE/ })).toBeNull();
    b.unmount();
    const c = wrap(<SonuPanel wr={base} meta={meta} role="foreman" userId="u1" />);
    expect(screen.queryByRole('button', { name: /Convert to 0 RFE/ })).toBeNull();
    c.unmount();
    wrap(<SonuPanel wr={base} meta={meta} role="coordinator" userId="u9" />);
    expect(screen.getByRole('button', { name: /Convert to 0 RFE/ })).toBeInTheDocument();
  });

  it('is not offered once the RFE is approved or the WR is gone', () => {
    const a = wrap(<SonuPanel wr={{ ...base, rfe: { approvedOn: '2026-11-01' } } as unknown as WrDetail} meta={meta} role="supervisor" userId="u1" />);
    expect(screen.queryByRole('button', { name: /Convert to 0 RFE/ })).toBeNull();
    a.unmount();
    wrap(<SonuPanel wr={{ ...base, goneAt: '2026-11-02' } as unknown as WrDetail} meta={meta} role="supervisor" userId="u1" />);
    expect(screen.queryByRole('button', { name: /Convert to 0 RFE/ })).toBeNull();
  });

  it('refuses QR 100 in the dialog and posts a valid amount', async () => {
    mockFetch();
    wrap(<SonuPanel wr={base} meta={meta} role="supervisor" userId="u1" />);
    await userEvent.click(screen.getByRole('button', { name: /Convert to 0 RFE/ }));
    expect(screen.getByText(/Material under QR 100 is bought locally with petty cash/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Expected amount/), '100');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Convert to 0 RFE' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('under QR 100');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.clear(screen.getByLabelText(/Expected amount/));
    await userEvent.type(screen.getByLabelText(/Expected amount/), '45.5');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Convert to 0 RFE' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ amount: 45.5 }));
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('/api/work-requests/1234567/zero-rfe');
  });

  it('shows the converted badge, and Undo only at coordinator level', () => {
    const conv = { ...base, internal: convertedInternal } as unknown as WrDetail;
    const a = wrap(<SonuPanel wr={conv} meta={meta} role="supervisor" userId="u1" />);
    expect(screen.getByTestId('zero-rfe-badge')).toHaveTextContent('0 RFE — local purchase');
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Convert to 0 RFE/ })).toBeNull();
    a.unmount();
    wrap(<SonuPanel wr={conv} meta={meta} role="coordinator" userId="u9" />);
    expect(screen.getByRole('button', { name: /Undo/ })).toBeInTheDocument();
  });

  it('lists local purchases with receipts and totals, and hides the section when not converted', () => {
    const conv = {
      ...base,
      internal: convertedInternal,
      localPurchases: [{ id: 'p1', item: 'Mixer tap', amount: 30.25, purchasedOn: '2026-11-09', pettyCashRef: 'PC-1', createdByName: 'Sam', createdById: 'u1', createdAt: '2026-11-09T09:00:00Z', attachments: [{ id: 'a1', fileName: 'r.png', mime: 'image/png' }] }],
    } as unknown as WrDetail;
    const a = wrap(<LocalPurchasesCard wr={conv} role="supervisor" userId="u1" />);
    expect(screen.getByText('Mixer tap')).toBeInTheDocument();
    expect(screen.getByTestId('purchases-total')).toHaveTextContent('Spent QR 30.25 of QR 45.5 expected');
    expect(screen.getByRole('link', { name: /Receipt r.png/ })).toHaveAttribute('href', '/api/attachments/a1');
    expect(screen.getByRole('button', { name: /Add purchase/ })).toBeInTheDocument();
    a.unmount();
    const b = wrap(<LocalPurchasesCard wr={base} role="supervisor" userId="u1" />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it('the report page renders totals and links each job', () => {
    const data: ZeroRfeReport = {
      month: '2026-11',
      totals: { jobs: 2, expected: 90, spent: 60.5, withoutReceipt: 1 },
      items: [
        { wrCode: '1234567', buildingName: 'Tower A', description: 'Leaking tap', zone: 'Z1', discipline: 'Plumbing', convertedAt: '2026-11-09T08:00:00Z', convertedByName: 'Sam', expected: 45, spent: 60.5, purchases: 2, receipts: 2, wrStatus: 'Assigned', qfStageLabel: '6. Issue & progress' },
        { wrCode: '7654321', buildingName: 'Tower B', description: 'Door lock', zone: 'Z2', discipline: 'Civil', convertedAt: '2026-11-10T08:00:00Z', convertedByName: 'Sam', expected: 45, spent: 0, purchases: 0, receipts: 0, wrStatus: 'Assigned', qfStageLabel: '6. Issue & progress' },
      ],
    };
    wrap(<ZeroRfeReportView data={data} />);
    expect(screen.getByText('0 RFE jobs')).toBeInTheDocument();
    expect(screen.getByText('Without receipt')).toBeInTheDocument();
    expect(screen.getByTestId('report-money')).toHaveTextContent('Expected QR 90 · spent QR 60.5');
    expect(screen.getByRole('link', { name: /1234567/ })).toHaveAttribute('href', '/work-requests/1234567');
    expect(screen.getByText('No receipt')).toBeInTheDocument();
  });

  it('the dashboard card links to the report and hides the QR part when spent is null', () => {
    const empty = { rows: [], columns: [], cells: {}, rowTotals: {}, columnTotals: {}, total: 0 } as never;
    const data = {
      today: '2026-11-09', totalOutstanding: 3, breached: 0, backlogKpi: 0, averageAge: 1,
      byDiscipline: empty, byZone: empty, byFacility: empty, byYear: {}, ageBuckets: {}, kpiSplit: {}, tdSplit: {}, rfeTimeFrameSplit: {},
      descriptiveStages: [{ stage: 6, label: '6. Issue & progress', count: 1 }],
      needsActionToday: { deadlinesToday: [], deadlinesTodayCount: 0, breachedDeadlines: 0, unowned: [], unownedCount: 0, returns: [], returnsCount: 0, unansweredComments: 0 },
      dataAsOf: null, zeroRfe: { monthJobs: 2, monthSpent: 30.5, withoutReceipt: 1 },
    } as unknown as DashboardData;
    const a = wrap(<DashboardView data={data} />);
    const card = screen.getByTestId('zero-rfe-card');
    expect(card).toHaveAttribute('href', '/zero-rfe');
    expect(card).toHaveTextContent('0 RFE this month: 2 jobs · QR 30.5 spent · 1 without receipt');
    a.unmount();
    wrap(<DashboardView data={{ ...data, zeroRfe: { monthJobs: 1, monthSpent: null, withoutReceipt: 0 } }} />);
    expect(screen.getByTestId('zero-rfe-card')).toHaveTextContent('0 RFE this month: 1 job · 0 without receipt');
  });
});
