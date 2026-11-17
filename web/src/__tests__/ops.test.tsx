import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import DashboardPage from '@/pages/DashboardPage';
import ImportsPage from '@/pages/ImportsPage';
import { JobActions, actionsFor } from '@/components/ops/JobActions';
import { SonuPanel } from '@/components/ops/SonuPanel';
import { internalPath, wrListUrl } from '@/lib/ops';
import { isStale } from '@/components/shell/slots';
import type { DashboardData, Matrix, Meta, WrDetail } from '@/lib/types';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function mockFetch(handler: (c: Call) => unknown | { __status: number; body: unknown }) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const c: Call = { url, method: init?.method ?? 'GET', body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null };
    calls.push(c);
    const out = handler(c) as { __status?: number; body?: unknown };
    const status = out && typeof out === 'object' && '__status' in out ? out.__status! : 200;
    const body = out && typeof out === 'object' && '__status' in out ? out.body : out;
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }));
}

const wrap = (ui: React.ReactElement, route = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter></QueryClientProvider>);
};

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { calls = []; });

const matrix = (rows: string[], columns: string[], cells: Record<string, Record<string, number>>): Matrix => {
  const rowTotals = Object.fromEntries(rows.map((r) => [r, columns.reduce((s, c) => s + (cells[r]?.[c] ?? 0), 0)]));
  const columnTotals = Object.fromEntries(columns.map((c) => [c, rows.reduce((s, r) => s + (cells[r]?.[c] ?? 0), 0)]));
  return { rows, columns, cells, rowTotals, columnTotals, total: Object.values(rowTotals).reduce((a, b) => a + b, 0) };
};

const dash: DashboardData = {
  today: '2026-11-17', totalOutstanding: 10, breached: 3, backlogKpi: 4, averageAge: 41.8,
  byDiscipline: matrix(['Awaiting Approval - QF', '(No status)'], ['HVAC', 'Electrical'], { 'Awaiting Approval - QF': { HVAC: 3, Electrical: 2 }, '(No status)': { HVAC: 1, Electrical: 4 } }),
  byZone: matrix(['Completed'], ['North'], { Completed: { North: 2 } }),
  byFacility: matrix(['Completed'], ['Hall'], { Completed: { Hall: 1 } }),
  byYear: { '2026': 10 }, ageBuckets: { 'Within Month': 6, 'More Than One month': 4 }, kpiSplit: { 'Backlog KPI': 4, 'Present KPI': 6 },
  tdSplit: { Breached: 3, 'TD Valid': 7 }, rfeTimeFrameSplit: { breach: 2, valid: 5 },
  descriptiveStages: null,
  needsActionToday: { deadlinesToday: [], deadlinesTodayCount: 0, breachedDeadlines: 1, unowned: [], unownedCount: 2, returns: [], returnsCount: 0, unansweredComments: 0 },
  dataAsOf: { at: '2026-11-17T08:00:00Z', by: 'Amal', listKey: 'wr_console' },
};

describe('Dashboard', () => {
  it('renders the status x discipline matrix with row, column and grand totals, and links to the filtered list', async () => {
    mockFetch(() => dash);
    wrap(<DashboardPage />);
    const table = await screen.findByRole('table', { name: 'Status by discipline' });
    expect(within(table).getByTestId('row-total-Awaiting Approval - QF')).toHaveTextContent('5');
    expect(within(table).getByTestId('row-total-(No status)')).toHaveTextContent('5');
    expect(within(table).getByTestId('col-total-HVAC')).toHaveTextContent('4');
    expect(within(table).getByTestId('col-total-Electrical')).toHaveTextContent('6');
    expect(within(table).getByTestId('grand-total')).toHaveTextContent('10');
    const cell = within(table).getByRole('link', { name: 'Awaiting Approval - QF, HVAC' });
    expect(cell).toHaveAttribute('href', '/work-requests?contractorStatus=Awaiting+Approval+-+QF&discipline=HVAC');
    // "(No status)" maps to the API's "(none)"
    expect(within(table).getByRole('link', { name: '(No status), HVAC' }).getAttribute('href')).toContain('contractorStatus=%28none%29');
    // no QF stage tiles when descriptiveStages is null
    expect(screen.queryByLabelText('QF stages')).toBeNull();
    expect(screen.getByRole('button', { name: /Export Master workbook/ })).toBeInTheDocument();
  });

  it('shows an error with a retry button when the API fails', async () => {
    mockFetch(() => ({ __status: 500, body: { error: { code: 'boom', message: 'Server broke' } } }));
    wrap(<DashboardPage />);
    expect(await screen.findByText('Server broke')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

describe('Imports', () => {
  it('names the missing caption in red and says nothing was loaded when a file is refused', async () => {
    mockFetch((c) => {
      if (c.url.startsWith('/api/imports/expected')) return { items: [] };
      if (c.url.startsWith('/api/imports') && c.method === 'GET') return { items: [] };
      if (c.url === '/api/imports' && c.method === 'POST') {
        return { __status: 422, body: { error: { code: 'missing_caption', message: 'This file is missing a column.', details: { batchId: 'b1', listKey: 'wr_console', missingCaptions: ['Work Request No'], candidates: [] } } } };
      }
      if (c.url === '/api/meta') return { contractorStatuses: [] };
      return {};
    });
    wrap(<ImportsPage />);
    const input = (await screen.findAllByTestId('filedrop-input'))[0]!;
    await userEvent.upload(input, new File(['x'], 'console.xlsx'));
    await userEvent.click(screen.getByRole('button', { name: /Upload file/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Work Request No');
    expect(alert).toHaveTextContent('Nothing was loaded');
    expect(alert.className).toContain('text-danger');
    expect(calls.some((c) => c.url === '/api/imports' && c.method === 'POST')).toBe(true);
  });
});

describe('Job buttons follow the job state', () => {
  it('lists the actions per state', () => {
    expect(actionsFor('assigned')).toEqual(['start']);
    expect(actionsFor('started')).toEqual(['update', 'done']);
    expect(actionsFor('done')).toEqual([]);
  });

  it('assigned shows Start only, started shows Update and Done, done shows nothing', () => {
    const { unmount } = wrap(<JobActions jobId="j1" status="assigned" />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    unmount();

    const b = wrap(<JobActions jobId="j1" status="started" />);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    b.unmount();

    const c = wrap(<JobActions jobId="j1" status="done" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    c.unmount();

    wrap(<JobActions jobId="j1" status="assigned" canAct={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('Start posts to the start route', async () => {
    mockFetch(() => ({}));
    wrap(<JobActions jobId="j1" status="assigned" />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/jobs/j1/start' && c.method === 'POST')).toBe(true));
  });
});

describe('Contractor status suggestion', () => {
  const wr = {
    wrCode: '1234567', internal: { ownerId: null, ownerName: null, criterion: null, contractorStatus: null, fcRemarks: null, statusSource: null, dueAt: null, breachLevel: null },
    suggestedStatus: { status: 'Awaiting Approval - QF', reason: 'the estimate was submitted' },
  } as unknown as WrDetail;
  const meta = { contractorStatuses: [{ name: 'Awaiting Approval - QF', side: 'qf' }, { name: 'Completed', side: 'either' }], criteria: [], people: [] } as unknown as Meta;

  it('shows "Suggested: ... because ..." and accepting sends a PATCH', async () => {
    mockFetch(() => ({}));
    wrap(<SonuPanel wr={wr} meta={meta} role="supervisor" userId="u1" />);
    const box = screen.getByTestId('status-suggestion');
    expect(box).toHaveTextContent('Suggested: Awaiting Approval - QF because the estimate was submitted');
    await userEvent.click(within(box).getByRole('button', { name: /Accept suggestion/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy());
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/work-requests/1234567');
    expect(patch.body).toEqual({ contractorStatus: 'Awaiting Approval - QF' });
  });

  it('read-only roles cannot accept', () => {
    wrap(<SonuPanel wr={wr} meta={meta} role="purchasing" userId="u1" />);
    expect(screen.queryByRole('button', { name: /Accept suggestion/ })).toBeNull();
  });
});

describe('helpers', () => {
  it('builds list URLs, maps server links and detects stale data', () => {
    expect(wrListUrl({ tdStatus: 'Breached', zone: '' })).toBe('/work-requests?tdStatus=Breached');
    expect(wrListUrl({})).toBe('/work-requests');
    expect(internalPath('/wr/1234567')).toBe('/work-requests/1234567');
    expect(internalPath('/my-jobs/abc')).toBe('/my-jobs/abc');
    expect(internalPath('https://x.y')).toBeNull();
    const now = new Date('2026-11-17T12:00:00Z');
    expect(isStale('2026-11-16T10:00:00Z', now)).toBe(true);
    expect(isStale('2026-11-17T08:00:00Z', now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
  });
});
