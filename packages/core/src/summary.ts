import type { AgeBucket, ComputedColumns, KpiLabel, RfeTimeFrameKind, TdStatus, WrInput } from './compute.js';
import { diffDays } from './dates.js';
import { CONTRACTOR_STATUSES } from './statuses.js';

/** A row as the summaries need it: WR facts + computed columns + the contractor's status. */
export type SummaryRow = Pick<WrInput, 'dateRequested'> &
  Pick<ComputedColumns, 'month' | 'tdStatus' | 'kpi' | 'discipline' | 'facility' | 'zone' | 'daysSinceRequested' | 'rfeTimeFrameKind'> & {
    /** Contractor status (one of the 15) or null / '' when nobody has set one. */
    status?: string | null;
  };

/** Status x something. `cells[status][column]`. Rows and columns are ordered (see `summarise`). */
export interface Matrix {
  rows: string[];
  columns: string[];
  cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  columnTotals: Record<string, number>;
  total: number;
}

export interface Summary {
  /** Number of open work requests (rows). */
  totalOutstanding: number;
  /** TD Status = Breached. */
  breached: number;
  /** KPI = Backlog KPI. */
  backlogKpi: number;
  /**
   * Average of the "No Of Days Since requested" column (today - Date Trade Assigned), rows without the date left out,
   * rounded to 1 decimal. (The workbook Dashboard shows 41.8 for 1,235 rows.)
   */
  averageAge: number;
  /** Average of today - Date Work Requested (the age behind the Month column), 1 decimal. Needs `today`. */
  averageAgeFromRequested: number | null;
  byDiscipline: Matrix;
  byZone: Matrix;
  byFacility: Matrix;
  /** Rows per year of Date Work Requested (workbook: 2024: 2, 2025: 17, 2026: 1,216). */
  byYear: Record<string, number>;
  ageBuckets: Record<AgeBucket, number>;
  kpiSplit: Record<KpiLabel, number>;
  tdSplit: Record<TdStatus, number>;
  rfeTimeFrameSplit: Record<RfeTimeFrameKind, number>;
}

export const NO_STATUS = '(No status)';

const statusOrder = new Map(CONTRACTOR_STATUSES.map((s, i) => [s.name, i]));

function matrix(rows: SummaryRow[], pick: (r: SummaryRow) => string): Matrix {
  const cells: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  const columnTotals: Record<string, number> = {};
  for (const r of rows) {
    const s = (r.status ?? '').trim() || NO_STATUS;
    const c = pick(r) || 'Unmapped';
    (cells[s] ??= {})[c] = (cells[s][c] ?? 0) + 1;
    rowTotals[s] = (rowTotals[s] ?? 0) + 1;
    columnTotals[c] = (columnTotals[c] ?? 0) + 1;
  }
  // Rows: by size (largest first, like the e-mail table), ties by the order of the 15 statuses, then name.
  const rowNames = Object.keys(rowTotals).sort(
    (a, b) =>
      rowTotals[b] - rowTotals[a] ||
      (statusOrder.get(a) ?? 99) - (statusOrder.get(b) ?? 99) ||
      a.localeCompare(b),
  );
  const colNames = Object.keys(columnTotals).sort((a, b) => columnTotals[b] - columnTotals[a] || a.localeCompare(b));
  for (const s of rowNames) for (const c of colNames) (cells[s] ??= {})[c] ??= 0;
  return { rows: rowNames, columns: colNames, cells, rowTotals, columnTotals, total: rows.length };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Same definitions as the workbook's Dashboard / Statistics / Summary sheets. */
export function summarise(rows: SummaryRow[], opts: { today?: string } = {}): Summary {
  const ageBuckets: Record<AgeBucket, number> = {
    'Within Month': 0,
    'More Than One month': 0,
    'More Than Two month': 0,
    'More Than Three month': 0,
    'No Date': 0,
  };
  const kpiSplit: Record<KpiLabel, number> = { 'Present KPI': 0, 'Backlog KPI': 0, 'Future KPI': 0, 'No TD': 0 };
  const tdSplit: Record<TdStatus, number> = { Breached: 0, 'TD Valid': 0, 'No TD': 0 };
  const rfeTimeFrameSplit: Record<RfeTimeFrameKind, number> = {
    valid: 0,
    breach: 0,
    submitted: 0,
    notRequired: 0,
    approved: 0,
    unknown: 0,
  };
  const byYear: Record<string, number> = {};
  let ageSum = 0;
  let ageN = 0;
  let reqSum = 0;
  let reqN = 0;
  for (const r of rows) {
    ageBuckets[r.month]++;
    kpiSplit[r.kpi]++;
    tdSplit[r.tdStatus]++;
    rfeTimeFrameSplit[r.rfeTimeFrameKind]++;
    const y = r.dateRequested ? r.dateRequested.slice(0, 4) : 'No date';
    byYear[y] = (byYear[y] ?? 0) + 1;
    if (r.daysSinceRequested !== null && r.daysSinceRequested !== undefined) {
      ageSum += r.daysSinceRequested;
      ageN++;
    }
    if (opts.today && r.dateRequested) {
      reqSum += diffDays(r.dateRequested, opts.today);
      reqN++;
    }
  }
  return {
    totalOutstanding: rows.length,
    breached: tdSplit.Breached,
    backlogKpi: kpiSplit['Backlog KPI'],
    averageAge: ageN ? r1(ageSum / ageN) : 0,
    averageAgeFromRequested: reqN ? r1(reqSum / reqN) : null,
    byDiscipline: matrix(rows, (r) => r.discipline),
    byZone: matrix(rows, (r) => r.zone),
    byFacility: matrix(rows, (r) => r.facility),
    byYear: Object.fromEntries(Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b))),
    ageBuckets,
    kpiSplit,
    tdSplit,
    rfeTimeFrameSplit,
  };
}
