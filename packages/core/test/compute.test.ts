import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, ageBucket, computeColumns, daysToBreach, disciplineFor, facilityZoneFor, kpiOf, loadLookups, parseExport, rfeStatusOf, rfeTimeFrameOf, summarise, tdStatus, todayInZone, buildMasterRows, type Summary } from '../src/index.js';
import { fx, fxJson, lookupsJson } from './helpers.js';

const T = '2026-11-09';
const ago = (n: number) => addDays(T, -n);

beforeAll(() => {
  loadLookups(lookupsJson());
});

describe('age bucket (Month)', () => {
  it.each([
    [0, 'Within Month'], [30, 'Within Month'], [31, 'More Than One month'], [61, 'More Than One month'],
    [62, 'More Than Two month'], [91, 'More Than Two month'], [92, 'More Than Three month'], [400, 'More Than Three month'],
  ])('age %i -> %s', (n, label) => expect(ageBucket(ago(n), T)).toBe(label));
  it('no date', () => expect(ageBucket(null, T)).toBe('No Date'));
});

describe('target date columns', () => {
  it('today equal to target is TD Valid, after is Breached, empty is No TD', () => {
    expect(tdStatus(T, T)).toBe('TD Valid');
    expect(tdStatus(ago(1), T)).toBe('Breached');
    expect(tdStatus(addDays(T, 1), T)).toBe('TD Valid');
    expect(tdStatus(null, T)).toBe('No TD');
  });
  it('days to breach = today - target', () => {
    expect(daysToBreach(ago(3), T)).toBe(3);
    expect(daysToBreach(T, T)).toBe(0);
    expect(daysToBreach(addDays(T, 5), T)).toBe(-5);
    expect(daysToBreach(null, T)).toBe('No TD');
  });
  it.each([
    ['2026-11-01', 'Present KPI'], ['2026-11-30', 'Present KPI'], ['2026-10-31', 'Backlog KPI'],
    ['2026-12-01', 'Future KPI'], ['2025-11-15', 'Backlog KPI'], ['2027-01-01', 'Future KPI'],
  ])('kpi %s -> %s', (d, k) => expect(kpiOf(d, T)).toBe(k));
  it('kpi no TD', () => expect(kpiOf(null, T)).toBe('No TD'));
});

describe('RFE status (all branches)', () => {
  const A = 'Assigned to Work Order';
  const I = 'Issued and In Process';
  it.each([
    [A, 0, null, 'RFE To Be Submitted'],
    [A, null, null, 'RFE To Be Submitted'],
    [A, 500, null, 'RFE Submitted'],
    [I, 0, null, 'RFE Not Required'],
    [I, 500, null, 'RFE Approved'],
    ['Contractor Completed', 0, null, 'RFE Not Required'],
    ['Completed', 10, null, 'RFE Approved'],
    ['Requested', 0, null, 'RFE Approved'],
    [A, 0, 'Monthly routine task', 'RFE Not Required'],
    [A, 900, 'monthly  routine', 'RFE Not Required'],
  ])('%s cost %s remark %s -> %s', (st, cost, rem, out) => {
    expect(rfeStatusOf({ wrStatus: st, estimatedTotalCost: cost, fcRemarks: rem })).toBe(out);
  });
});

describe('RFE time frame', () => {
  const wr = (assignedAgo: number) => ({ wrStatus: 'Assigned to Work Order', estimatedTotalCost: 0, fcRemarks: null, dateTradeAssigned: ago(assignedAgo) });
  it('limit 14: day 13, 14 are inside, 15 is crossed', () => {
    expect(rfeTimeFrameOf(wr(13), T).label).toBe('RFE Valid Time Frame - 1 Days Remaining');
    expect(rfeTimeFrameOf(wr(14), T).label).toBe('RFE Valid Time Frame - 0 Days Remaining');
    expect(rfeTimeFrameOf(wr(15), T).label).toBe('RFE Time Breach - 1 Days Crossed');
    expect(rfeTimeFrameOf(wr(0), T).label).toBe('RFE Valid Time Frame - 14 Days Remaining');
  });
  it('custom limits', () => {
    expect(rfeTimeFrameOf(wr(15), T, 20).label).toBe('RFE Valid Time Frame - 5 Days Remaining');
    expect(rfeTimeFrameOf(wr(13), T, 10).label).toBe('RFE Time Breach - 3 Days Crossed');
    expect(computeColumns({ ...wr(15), wrCode: '1' }, { today: T, rfeLimitDays: 20 }).rfeTimeFrameKind).toBe('valid');
  });
  it('other rows show their RFE status', () => {
    expect(rfeTimeFrameOf({ wrStatus: 'Assigned to Work Order', estimatedTotalCost: 5, dateTradeAssigned: ago(30) }, T).label).toBe('RFE Submitted');
    expect(rfeTimeFrameOf({ wrStatus: 'Issued and In Process', estimatedTotalCost: 0 }, T).label).toBe('RFE Not Required');
  });
});

describe('computeColumns and lookups', () => {
  it('full row', () => {
    const c = computeColumns(
      { wrCode: '9100001', wrStatus: 'Assigned to Work Order', estimatedTotalCost: 0, dateRequested: ago(40), dateTradeAssigned: ago(10), targetDate: ago(2), siteCode: 'ecsq', problemType: 'civi' },
      { today: T, rfeLookup: new Map([['9100001', { submittedOn: '2026-10-01', approvedOn: null }]]) },
    );
    expect(c).toMatchObject({ month: 'More Than One month', daysToBreach: 2, tdStatus: 'Breached', kpi: 'Present KPI', rfeSubmittedOn: '2026-10-01', rfeApprovedOn: null, discipline: 'Civil', facility: 'Al Shaqab', zone: 'Zone-1', rfeStatus: 'RFE To Be Submitted', daysSinceRequested: 10, rfeTimeFrame: 'RFE Valid Time Frame - 4 Days Remaining' });
  });
  it('unknown values are Unmapped and never throw', () => {
    expect(disciplineFor('nope')).toBe('Unmapped');
    expect(disciplineFor(null)).toBe('Unmapped');
    expect(facilityZoneFor('ZZZZ')).toEqual({ facility: 'Unmapped', zone: 'Unmapped' });
    expect(disciplineFor('CAPM|ELEC')).toBe('Electrical');
    expect(facilityZoneFor('OEWH').zone).toBe('Zone-1');
  });
  it('todayInZone', () => {
    const now = new Date('2026-11-09T22:30:00Z');
    expect(todayInZone('Asia/Qatar', now)).toBe('2026-11-10');
    expect(todayInZone('UTC', now)).toBe('2026-11-09');
  });
});

describe('summarise vs expected-counts.json', () => {
  const exp = fxJson('expected-counts.json');
  const r = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
  const rfe = parseExport('review_approved_estimations', fx('review-approved-estimations.xlsx'));
  const tr = fx('tracker-master.xlsx');
  it('matches', async () => {
    if (!r.ok || !rfe.ok) throw new Error('parse');
    const { parseTrackerWorkbook } = await import('../src/index.js');
    const t = parseTrackerWorkbook(tr);
    if (!t.ok) throw new Error('tracker');
    const typed = new Map(t.rows.map((x) => [x.wrCode, { status: x.status, fcRemarks: x.fcRemarks || null }]));
    const lookup = new Map(rfe.rows.map((x) => [String(x.wrCode), { submittedOn: x.rfeSubmittedOn as string | null, approvedOn: x.rfeApprovedOn as string | null }]));
    const rows = buildMasterRows(r.rows, { today: exp.referenceDate, rfeLookup: lookup, typed });
    const s: Summary = summarise(rows, { today: exp.referenceDate });
    expect(s.totalOutstanding).toBe(exp.totalOutstanding);
    expect(s.breached).toBe(exp.breached);
    expect(s.backlogKpi).toBe(exp.backlogKpi);
    expect(s.averageAge).toBe(exp.averageDaysSinceAssigned);
    const nz = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
    expect(nz(s.ageBuckets)).toEqual(exp.ageBuckets);
    expect(nz(s.kpiSplit)).toEqual(exp.kpiSplit);
    expect(nz(s.tdSplit)).toEqual(exp.tdSplit);
    expect(nz(s.rfeTimeFrameSplit)).toEqual(exp.rfeTimeFrameSplit);
    expect(s.byYear).toEqual(exp.byYear);
    const flat = (m: Summary['byZone']) => Object.fromEntries(m.rows.map((st) => [st, nz(m.cells[st])]));
    expect(flat(s.byDiscipline)).toEqual(exp.statusByDiscipline);
    expect(flat(s.byZone)).toEqual(exp.statusByZone);
    expect(flat(s.byFacility)).toEqual(exp.statusByFacility);
    const rfeStatus: Record<string, number> = {};
    for (const x of rows) rfeStatus[x.rfeStatus] = (rfeStatus[x.rfeStatus] ?? 0) + 1;
    expect(rfeStatus).toEqual(exp.rfeStatus);
  });
});
