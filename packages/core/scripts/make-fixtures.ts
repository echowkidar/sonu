/**
 * Generates the synthetic fixture files into ../../fixtures (app\fixtures) with the EXACT export captions and
 * clearly fictional data. Deterministic: fixed seed, all dates relative to the reference date 2026-11-09.
 *
 * `expected-counts.json` and `expected-events.json` are computed here, straight from the generator's own rows with
 * plain arithmetic - they do NOT use summarise(), computeColumns() or diffMirror() - so tests can compare them.
 */
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORTS, buildMasterRows, summarise, writeMasterWorkbook, loadLookups, type ListKey, type TypedRow } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../fixtures');
const LOOKUPS_JSON = resolve(here, '../../../assets/tracker-lookups.json');
const REF = '2026-11-09';

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------------------------------- helpers
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261109);
const rint = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];

const dn = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5);
const fromDn = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
const plus = (iso: string, d: number) => fromDn(dn(iso) + d);
const serial = (iso: string) => dn(iso) + 25569;

type Cell = string | number | null | { date: string };

async function writeXlsx(file: string, captions: string[], rows: Cell[][], titleRows: string[] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  for (const t of titleRows) ws.addRow([t]);
  ws.addRow(captions);
  for (const r of rows) {
    const row = ws.addRow(r.map((c) => (c && typeof c === 'object' ? new Date(`${c.date}T00:00:00Z`) : c)));
    r.forEach((c, i) => {
      if (c && typeof c === 'object') row.getCell(i + 1).numFmt = 'dd/mm/yyyy';
    });
  }
  writeFileSync(join(OUT, file), Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
}

function writeXls(file: string, captions: string[], rows: Cell[][], titleRows: string[] = []) {
  const aoa: unknown[][] = [...titleRows.map((t) => [t]), captions];
  for (const r of rows) aoa.push(r.map((c) => (c && typeof c === 'object' ? { t: 'n', v: serial(c.date), z: 'dd/mm/yyyy' } : c)));
  // aoa_to_sheet takes objects with t/v/z as cells
  const ws = XLSX.utils.aoa_to_sheet(aoa as never);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  writeFileSync(join(OUT, file), XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
}

// ---------------------------------------------------------------------------------------------------- data
const lookups = JSON.parse(readFileSync(LOOKUPS_JSON, 'utf8')) as {
  site_to_facility_zone: Record<string, { zone: string; group: string; facility: string }>;
  problem_type_to_discipline: Record<string, string>;
};
const siteInfo = (code: string) => {
  const s = lookups.site_to_facility_zone[code];
  return s ? { zone: s.zone || s.group, facility: s.facility } : { zone: 'Unmapped', facility: 'Unmapped' };
};
const disciplineOf = (pt: string) => lookups.problem_type_to_discipline[pt] ?? 'Unmapped';

const SITES = ['ECSQ', 'ECHO', 'ECCR', 'OEWH', 'ECIE', 'ECPC', 'ECQA', 'ECJS', 'ECSN', 'OESQ', 'AKRM', 'OEMD', 'OEBB'];
const PROBLEMS = ['CIVI', 'ELEC', 'HVAC', 'MECH', 'INST', 'GSER', 'OPERATIONS', 'CAPM|CIVI', 'CAPM|ELEC', 'CIVI', 'ELEC', 'HVAC'];
const STATUSES = [
  'Awaiting Information - TDGI', 'Awaiting Quote - TDGI', 'RFE to be submit - TDGI', 'RFE to be Resubmitted - TDGI',
  'Awaiting Material - TDGI', 'Material received under planning - TDGI', 'Work In Progress - TDGI',
  'Awaiting Approval - QF', 'Awaiting Information - QF', 'Awaiting Material - QF', 'Awaiting budget code - QF',
  'Awaiting Access - QF', 'Completed', 'Duplicate', 'To be cancelled',
];
const REQ_AGES = [0, 5, 12, 20, 29, 30, 31, 40, 55, 60, 61, 62, 70, 85, 90, 91, 92, 100, 140, 200, 320, 480, 700];
const TD_OFFSETS: (number | null)[] = [-40, -9, -8, -1, 0, 0, 1, 5, 21, 22, 60, -120, 3, -20, 12, null];
const COSTS = [350, 1200, 4800, 15250.5, 780, 22000, 3150, 640];
const ASSIGNED = 'Assigned to Work Order';
const ISSUED = 'Issued and In Process';
const COMPLETED = 'Completed';
const ROUTINE = 'Monthly Routine Activities WR to be closed at the end of the Month';

interface Wr {
  wrCode: string;
  dateRequested: string;
  dateTradeAssigned: string;
  targetDate: string | null;
  wrStatus: string;
  cost: number;
  siteCode: string;
  problemType: string;
  status: string | null;
  fcRemarks: string;
  n: number;
}

const N = 60;
const wrs: Wr[] = [];
for (let i = 0; i < N; i++) {
  const reqAge = i < REQ_AGES.length ? REQ_AGES[i] : REQ_AGES[rint(0, REQ_AGES.length - 1)];
  let assignedAge = Math.max(0, reqAge - rint(0, 4));
  let wrStatus = rng() < 0.55 ? ASSIGNED : ISSUED;
  let cost = rng() < 0.62 ? 0 : pick(COSTS);
  const forced = [3, 4, 5].indexOf(i % 10);
  let reqAgeFinal = reqAge;
  if (forced >= 0 && i < 55) {
    // RFE time frame boundary rows: assigned 13 / 14 / 15 days ago, assigned status, cost 0.
    assignedAge = 13 + forced;
    reqAgeFinal = assignedAge + rint(0, 3);
    wrStatus = ASSIGNED;
    cost = 0;
  }
  if (i % 13 === 12 && !(forced >= 0 && i < 55)) wrStatus = i % 26 === 12 ? COMPLETED : 'Contractor Completed';
  const tdOff = TD_OFFSETS[i % TD_OFFSETS.length];
  const code = i === N - 1 ? '0100060' : String(9100001 + i);
  const site = i === 7 ? 'ZZZZ' : SITES[(i * 5 + 1) % SITES.length];
  const problem = i === 9 ? 'XXXX' : PROBLEMS[(i * 7 + 2) % PROBLEMS.length];
  const status = i === 13 || i === 41 ? null : STATUSES[(i * 4 + (i >> 2)) % STATUSES.length];
  wrs.push({
    wrCode: code,
    dateRequested: plus(REF, -reqAgeFinal),
    dateTradeAssigned: plus(REF, -assignedAge),
    targetDate: tdOff === null ? null : plus(REF, tdOff),
    wrStatus,
    cost,
    siteCode: site,
    problemType: problem,
    status,
    fcRemarks: i % 6 === 0 ? 'Test remark - waiting for sample' : i % 17 === 0 ? ROUTINE : '',
    n: i + 1,
  });
}

const PENDING = EXPORTS.pending_work_requests.captions;
const pad3 = (n: number) => String(n).padStart(3, '0');

function pendingCells(w: Wr): Cell[] {
  const m: Record<string, Cell> = {
    'Work Request Code': w.wrCode,
    'Work Request Status': w.wrStatus,
    'Service Request Code': String(5000000 + w.n),
    'Permit to Work Code': w.n % 4 === 0 ? `PTW-TEST-${pad3(w.n)}` : null,
    'Permit to Work Status': w.n % 4 === 0 ? 'Issued' : null,
    'Requestor Name': `Requestor ${pad3(w.n)}`,
    'Contractor': 'Test Contractor W.L.L.',
    'Site Code': w.siteCode,
    'Site Name': `Test Site ${w.siteCode}`,
    'Building Code': `${w.siteCode}-B${pad3((w.n % 9) + 1)}`,
    'Building Name': `Test Building ${pad3((w.n % 9) + 1)}`,
    'Floor Code': `F${(w.n % 4) + 1}`,
    'Room Code': `R${pad3(w.n)}`,
    'Directorate Code': 'TEST-DIR',
    'Department Code': 'TEST-DEP',
    'Equipment Code': w.n % 3 === 0 ? `EQ-TEST-${pad3(w.n)}` : null,
    'Equipment Standard': w.n % 3 === 0 ? 'TEST-STD' : null,
    'Problem Type': w.problemType,
    'Problem Type Description': `Test problem type ${w.problemType}`,
    'Work Team Code': `TEST-WT-${(w.n % 3) + 1}`,
    'Work Request Priority': ((w.n % 4) + 1),
    'WR Description': `Test description ${pad3(w.n)} - sample work, fictional`,
    'Date Work Requested': { date: w.dateRequested },
    'Agreed Target Date': w.targetDate ? { date: w.targetDate } : null,
    'Date Trade Assigned': { date: w.dateTradeAssigned },
    'Estimated Total Cost': w.cost,
  };
  return PENDING.map((c) => m[c] ?? null);
}

// -------------------------------------------------------------------------------- expected counts (independent)
const statusKey = (w: Wr) => w.status ?? '(No status)';
function matrixOf(list: Wr[], pickCol: (w: Wr) => string) {
  const out: Record<string, Record<string, number>> = {};
  for (const w of list) {
    const r = (out[statusKey(w)] ??= {});
    r[pickCol(w)] = (r[pickCol(w)] ?? 0) + 1;
  }
  return out;
}

function expectedCounts(list: Wr[]) {
  const age = (w: Wr) => dn(REF) - dn(w.dateRequested);
  const since = (w: Wr) => dn(REF) - dn(w.dateTradeAssigned);
  const inc = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  const ageBuckets: Record<string, number> = {};
  const kpi: Record<string, number> = {};
  const td: Record<string, number> = {};
  const rfe: Record<string, number> = {};
  const tf: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  let sinceSum = 0;
  for (const w of list) {
    const a = age(w);
    inc(ageBuckets, a < 31 ? 'Within Month' : a < 62 ? 'More Than One month' : a < 92 ? 'More Than Two month' : 'More Than Three month');
    if (w.targetDate === null) {
      inc(kpi, 'No TD');
      inc(td, 'No TD');
    } else {
      inc(td, dn(REF) > dn(w.targetDate) ? 'Breached' : 'TD Valid');
      const ym = w.targetDate.slice(0, 7);
      inc(kpi, ym === REF.slice(0, 7) ? 'Present KPI' : ym < REF.slice(0, 7) ? 'Backlog KPI' : 'Future KPI');
    }
    const st = w.wrStatus;
    const assigned = st === ASSIGNED;
    const routine = w.fcRemarks.trim().toLowerCase() === ROUTINE.toLowerCase();
    let status: string;
    if (routine) status = 'RFE Not Required';
    else if (assigned && w.cost === 0) status = 'RFE To Be Submitted';
    else if ([ISSUED, COMPLETED, 'Contractor Completed'].includes(st) && w.cost === 0) status = 'RFE Not Required';
    else if (assigned && w.cost > 0) status = 'RFE Submitted';
    else status = 'RFE Approved';
    inc(rfe, status);
    // Time frame is independent of the RFE status and of remarks.
    if (st === ISSUED && w.cost === 0) inc(tf, 'notRequired');
    else if (w.cost > 0) inc(tf, 'submitted');
    else if (assigned) inc(tf, since(w) <= 14 ? 'valid' : 'breach');
    else inc(tf, 'unknown');
    inc(byYear, w.dateRequested.slice(0, 4));
    sinceSum += since(w);
  }
  return {
    referenceDate: REF,
    totalOutstanding: list.length,
    breached: td['Breached'] ?? 0,
    backlogKpi: kpi['Backlog KPI'] ?? 0,
    averageDaysSinceAssigned: Math.round((sinceSum / list.length) * 10) / 10,
    ageBuckets,
    kpiSplit: kpi,
    tdSplit: td,
    rfeStatus: rfe,
    rfeTimeFrameSplit: tf,
    byYear,
    statusByDiscipline: matrixOf(list, (w) => disciplineOf(w.problemType)),
    statusByZone: matrixOf(list, (w) => siteInfo(w.siteCode).zone),
    statusByFacility: matrixOf(list, (w) => siteInfo(w.siteCode).facility),
  };
}

// ----------------------------------------------------------------------------------------------- main files
async function main() {
  await writeXlsx('pending-work-requests.xlsx', PENDING, wrs.map(pendingCells));
  writeXls('pending-work-requests.xls', PENDING, wrs.map(pendingCells));
  await writeXlsx('pending-work-requests-title-rows.xlsx', PENDING, wrs.map(pendingCells), [
    'Pending Work Requests (fictional test export)',
    `Generated for tests - reference date ${REF}`,
    '',
  ]);
  // Renamed column: Marafiq renamed "Agreed Target Date" -> "Agreed Due Date".
  await writeXlsx('pending-work-requests-renamed-column.xlsx', PENDING.map((c) => (c === 'Agreed Target Date' ? 'Agreed Due Date' : c)), wrs.map(pendingCells));

  // Review Approved Estimations: WRs with a cost that are not "Assigned" or are, plus two older ones.
  const rfeRows: { w: Wr | null; code: string; submitted: string; approved: string | null }[] = [];
  for (const w of wrs.filter((x) => x.cost > 0 && x.n % 2 === 0)) {
    const sub = plus(w.dateTradeAssigned, rint(1, 5));
    const subClamped = dn(sub) > dn(REF) ? w.dateTradeAssigned : sub;
    const app = plus(subClamped, rint(2, 8));
    rfeRows.push({ w, code: w.wrCode, submitted: subClamped, approved: dn(app) > dn(REF) ? null : app });
  }
  rfeRows.push({ w: null, code: '9000501', submitted: plus(REF, -60), approved: plus(REF, -50) });
  rfeRows.push({ w: null, code: '9000502', submitted: plus(REF, -45), approved: plus(REF, -41) });
  const APPROVED = EXPORTS.review_approved_estimations.captions;
  await writeXlsx(
    'review-approved-estimations.xlsx',
    APPROVED,
    rfeRows.map((r) => {
      const m: Record<string, Cell> = {
        'Work Request Code': r.code,
        'Site Code': r.w?.siteCode ?? 'ECSQ',
        'Building Code': r.w ? `${r.w.siteCode}-B001` : 'ECSQ-B001',
        'RFE Submitted On': { date: r.submitted },
        'RFE Approved On': r.approved ? { date: r.approved } : null,
        'Work Team Code': 'TEST-WT-1',
        'Work Description': `Test approved estimation ${r.code}`,
      };
      return APPROVED.map((c) => m[c] ?? null);
    }),
  );

  // ---------------------------------------------------------------- changed version of the pending list
  const events: { type: string; key: string; fields?: string[] }[] = [];
  const changed: Wr[] = wrs.map((w) => ({ ...w }));
  const removeIdx = [4, 16, 32, 47];
  const byIdx = (i: number) => changed[i];
  // Status changes (wr.stage_changed): Assigned -> Issued
  const statusIdx = changed.map((w, i) => ({ w, i })).filter(({ w, i }) => w.wrStatus === ASSIGNED && !removeIdx.includes(i)).slice(0, 3).map((x) => x.i);
  for (const i of statusIdx) {
    byIdx(i).wrStatus = ISSUED;
    events.push({ type: 'wr.stage_changed', key: byIdx(i).wrCode });
  }
  // Target date changes (wr.changed targetDate): +14 days (not touching the removed rows or the status ones twice)
  const tdIdx = changed.map((w, i) => ({ w, i })).filter(({ w, i }) => w.targetDate && !removeIdx.includes(i) && !statusIdx.includes(i)).slice(3, 5).map((x) => x.i);
  for (const i of tdIdx) {
    byIdx(i).targetDate = plus(byIdx(i).targetDate!, 14);
    events.push({ type: 'wr.changed', key: byIdx(i).wrCode, fields: ['targetDate'] });
  }
  // One WR with both a status change and a target date change.
  const bothIdx = changed.map((w, i) => ({ w, i })).find(({ w, i }) => w.wrStatus === ASSIGNED && w.targetDate && !removeIdx.includes(i) && !statusIdx.includes(i) && !tdIdx.includes(i))!.i;
  byIdx(bothIdx).wrStatus = ISSUED;
  byIdx(bothIdx).targetDate = plus(byIdx(bothIdx).targetDate!, 7);
  events.push({ type: 'wr.stage_changed', key: byIdx(bothIdx).wrCode });
  events.push({ type: 'wr.changed', key: byIdx(bothIdx).wrCode, fields: ['targetDate'] });
  // Cost changes (wr.changed estimatedTotalCost): one 0 -> amount, one amount -> other amount
  const used = new Set([...removeIdx, ...statusIdx, ...tdIdx, bothIdx]);
  const zeroIdx = changed.findIndex((w, i) => !used.has(i) && w.cost === 0);
  byIdx(zeroIdx).cost = 2500;
  used.add(zeroIdx);
  events.push({ type: 'wr.changed', key: byIdx(zeroIdx).wrCode, fields: ['estimatedTotalCost'] });
  const posIdx = changed.findIndex((w, i) => !used.has(i) && w.cost > 0);
  byIdx(posIdx).cost = byIdx(posIdx).cost + 1000;
  events.push({ type: 'wr.changed', key: byIdx(posIdx).wrCode, fields: ['estimatedTotalCost'] });
  // Gone
  for (const i of removeIdx) events.push({ type: 'wr.gone', key: changed[i].wrCode });
  const kept = changed.filter((_, i) => !removeIdx.includes(i));
  // New
  for (let k = 0; k < 3; k++) {
    const w: Wr = {
      wrCode: String(9100101 + k), dateRequested: plus(REF, -(k + 1)), dateTradeAssigned: plus(REF, -k), targetDate: plus(REF, 14 + k),
      wrStatus: ASSIGNED, cost: 0, siteCode: SITES[k], problemType: PROBLEMS[k], status: null, fcRemarks: '', n: 100 + k + 1,
    };
    kept.push(w);
    events.push({ type: 'wr.seen', key: w.wrCode });
  }
  await writeXlsx('pending-work-requests-changed.xlsx', PENDING, kept.map(pendingCells));
  events.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }) || a.type.localeCompare(b.type));
  writeFileSync(join(OUT, 'expected-events.json'), JSON.stringify({ list: 'pending_work_requests', from: 'pending-work-requests.xlsx', to: 'pending-work-requests-changed.xlsx', events }, null, 2));

  // ---------------------------------------------------------------- the other lists (small files)
  const simple = async (key: ListKey, file: string, rows: Record<string, Cell>[]) => {
    const caps = EXPORTS[key].captions;
    await writeXlsx(file, caps, rows.map((r) => caps.map((c) => r[c] ?? null)));
  };
  const some = wrs.slice(0, 8);
  await simple('wr_dashboard', 'wr-dashboard.xlsx', some.map((w, i) => ({
    'Action Item ID': 7000000 + w.n, 'Assigned to Work Order': 8000000 + w.n, 'Work Request Code': w.wrCode, 'Site Code': w.siteCode,
    'Site Name': `Test Site ${w.siteCode}`, 'Building Code': `${w.siteCode}-B001`, 'Building Name': 'Test Building 001', 'Floor Code': 'F1',
    'Room Code': `R${pad3(w.n)}`, 'Equipment Code': null, 'Date Work Requested': { date: w.dateRequested },
    'Agreed Target Date': w.targetDate ? { date: w.targetDate } : null, 'Date Trade Assigned': { date: w.dateTradeAssigned },
    'Requested by': `Requestor ${pad3(w.n)}`, 'Problem Type': w.problemType, 'Work Request Priority': 2, 'Estimated Total Cost': w.cost,
    'Work Team Code': 'TEST-WT-1', 'Contractor': 'Test Contractor W.L.L.', 'Work Request Status': w.wrStatus,
    'WR Descriptive Status': ['2. SP : Awaiting Site Survey & Estimation', '3. QF : Awaiting Estimation Approval', '4. SP : Awaiting Estimation Re-Submission', '5. SP : Estimation Approved & AMC & WIP'][i % 4],
    'Work Description': `Test description ${pad3(w.n)}`,
  })));
  await simple('estimate_and_schedule', 'estimate-and-schedule.xlsx', some.slice(0, 6).map((w) => ({
    'Work Request Code': w.wrCode, 'PTW Id': null, 'PTW status': null, 'Requested by': `Requestor ${pad3(w.n)}`, 'Problem Type': w.problemType,
    'Work Request Priority': 2, 'Work Team Code': 'TEST-WT-1', 'Date Work Requested': { date: w.dateRequested }, 'Site Code': w.siteCode,
    'Building Code': `${w.siteCode}-B001`, 'Floor Code': 'F1', 'Room Code': `R${pad3(w.n)}`, 'Step Type': 'estimation',
    'Date Assigned': { date: w.dateTradeAssigned }, 'Work Description': `Test description ${pad3(w.n)}`, 'Action Item ID': 7000000 + w.n,
    'Assigned to Work Order': 8000000 + w.n, 'With RFE?': w.cost > 0 ? 'Yes' : 'No', 'Estimated Total Cost': w.cost,
  })));
  await simple('edit_update_wrs', 'edit-update-wrs.xlsx', some.slice(0, 5).map((w) => ({
    'Work Request Code': w.wrCode, 'Assigned to Work Order': 8000000 + w.n, 'Action Item ID': 7000000 + w.n,
    'Date Work Requested': { date: w.dateRequested }, 'Date to Perform': { date: plus(w.dateTradeAssigned, 2) },
    'Agreed Target Date': w.targetDate ? { date: w.targetDate } : null, 'Work Request Priority': 2, '% Progress': 25 * (w.n % 4),
    'Site Code': w.siteCode, 'Building Code': `${w.siteCode}-B001`, 'Building Name': 'Test Building 001', 'Problem Type': w.problemType,
    'Work Request Status': ISSUED, 'Work Description': `Test description ${pad3(w.n)}`, 'Work Team Code': 'TEST-WT-1',
    'Wr Closure Comments': w.n % 2 ? null : 'Test closure comment',
  })));
  await simple('issue_wr', 'issue-wr.xlsx', some.slice(0, 5).map((w) => ({
    'Permit to Work Code': `PTW-TEST-${pad3(w.n)}`, 'Permit to work status': 'Requested', 'Service Request ID': 5000000 + w.n, 'Work Request Code': w.wrCode,
    'Assigned to Work Order': 8000000 + w.n, 'Primary Trade': 'TEST', 'Site Code': w.siteCode, 'Building Code': `${w.siteCode}-B001`,
    'Date Work Requested': { date: w.dateRequested }, 'Problem Type': w.problemType, 'Work Description': `Test description ${pad3(w.n)}`,
    'Work Request Priority': 2, 'Requested by': `Requestor ${pad3(w.n)}`, 'Agreed Target Date': w.targetDate ? { date: w.targetDate } : null,
    'Work Team Code': 'TEST-WT-1',
  })));
  await simple('rfe_post_box', 'rfe-post-box.xlsx', some.slice(0, 4).map((w, i) => ({
    'Other Res. Log ID': 600000 + i, 'Work Request Code': w.wrCode, 'Date Used': { date: plus(REF, -i) }, 'Time Used': '10:00',
    'Quantity Estimated': 1, 'Estimated Cost': 100 * (i + 1), 'Comments': `Test QF comment ${i + 1} - please clarify the quantity`,
    'Created By': `Reviewer ${pad3(i + 1)}`, 'Send To': 'TEST-CONTRACTOR', 'Date Created': { date: plus(REF, -i) }, 'Time Created': '10:05',
  })));
  await simple('pending_rfe_status', 'pending-rfe-status.xlsx', some.filter((w) => w.cost > 0).slice(0, 5).map((w) => ({
    'Work Request Code': w.wrCode, 'Date Work Requested': { date: w.dateRequested }, 'Date RFE Submitted': { date: w.dateTradeAssigned },
    'Site Code': w.siteCode, 'Building Code': `${w.siteCode}-B001`, 'Contractor': 'Test Contractor W.L.L.', 'Work Team Code': 'TEST-WT-1',
    'Problem Type': w.problemType, 'Pending With': 'QF Reviewer', 'RFE Amount': w.cost, 'Total Amount': w.cost, 'Work Description': `Test description ${pad3(w.n)}`,
  })));
  await simple('manage_permit_to_work', 'manage-permit-to-work.xlsx', [-3, 0, 1, 2, 3, 10].map((off, i) => ({
    'Permit to Work Code': `PTW-TEST-${pad3(i + 1)}`, 'Site Name': 'Test Site', 'Building Name': 'Test Building 001', 'Date Created': { date: plus(REF, -20) },
    'Date Issued': { date: plus(REF, -15) }, 'Date Start': { date: plus(REF, -14) }, 'Date Upto': { date: plus(REF, off) }, 'Description': `Test permit ${i + 1}`,
    'Permit to Work Status': i === 0 ? 'Expired' : 'Issued', 'Created By': 'Requestor 001', 'Permit Applicant': 'Requestor 001', 'Permit Authority': 'Authority 001',
    'Permit Controller': 'Controller 001', 'Building Focal Point': 'Focal 001', 'Contractor': 'Test Contractor W.L.L.', 'Project Code': 'TEST-PRJ', 'TRAM Reviewer': null,
  })));
  await simple('end_to_end_wr_to_invoice', 'end-to-end-wr-to-invoice.xlsx', [0, 0, 1, 2, 3, 3].map((k, j) => {
    const w = wrs[k];
    return {
      'Work Request Code': w.wrCode, 'Requestor': `Requestor ${pad3(w.n)}`, 'Date WR Estimated': { date: w.dateTradeAssigned }, 'Work Request Status': w.wrStatus,
      'Site Code': w.siteCode, 'Building Code': `${w.siteCode}-B001`, 'Problem Type': w.problemType, 'Work Team Code': 'TEST-WT-1', 'Contractor': 'Test Contractor W.L.L.',
      'BPA Agreement': 'TEST-BPA-1', 'Demand Note': `DN-TEST-${k + 1}`, 'Date Created': { date: plus(REF, -10) }, 'Demand Note Status': 'Approved',
      'PO Number': `PO-TEST-${k + 1}`, 'PO Date': { date: plus(REF, -8) }, 'PO Status': 'Open', 'PR Number': `PR-TEST-${k + 1}`, 'PR Date': { date: plus(REF, -9) }, 'PR Status': 'Approved',
      'Demand Note Line Number': j + 1, 'Reference Code': 'TEST-REF', 'BPA Line No.': j + 1, 'Item': 'TEST-ITEM', 'Item Description': 'Test item',
      'Units (BPA)': 'EACH', 'Quantity Estimated': 2, 'Actual Quantity': 2, 'Unit Cost': 100, 'Cost Estimated': 200, 'Cost Actual': 200, 'Account Code': 'TEST-ACC',
      'WCC Number': k === 3 ? 'WCC-TEST-1' : null, 'WCC Status': k === 3 ? 'Open' : null, 'Invoice Number': null, 'invoice status': null, 'Po type': 'Standard',
    };
  }));
  await simple('boq_details', 'boq-details.xlsx', wrs.slice(0, 5).map((w) => ({
    'Work Request Code': w.wrCode, 'Site Code': w.siteCode, 'Building Code': `${w.siteCode}-B001`, 'Problem Type': w.problemType, 'Work Team Code': 'TEST-WT-1',
    'Date Work Assigned': { date: w.dateTradeAssigned }, 'Work Request Status': w.wrStatus, 'Account Code': 'TEST-ACC', 'Unit of Measure': 'EACH', 'Unit Cost': 100,
    'Estimated Cost': 200, 'Actual Cost': 180, 'BPA Agreement No': 'TEST-BPA-1', 'Line No': 1, 'Item No': 'TEST-ITEM', 'Work Description': `Test description ${pad3(w.n)}`,
  })));

  // ---------------------------------------------------------------- tracker master + expected counts
  loadLookups(lookups);
  const pendingTyped: TypedRow[] = wrs.map((w) => ({
    wrCode: w.wrCode, wrStatus: w.wrStatus, requestor: `Requestor ${pad3(w.n)}`, siteCode: w.siteCode, siteName: `Test Site ${w.siteCode}`,
    buildingCode: `${w.siteCode}-B${pad3((w.n % 9) + 1)}`, buildingName: `Test Building ${pad3((w.n % 9) + 1)}`, problemType: w.problemType,
    description: `Test description ${pad3(w.n)} - sample work, fictional`, priority: String((w.n % 4) + 1), workTeamCode: `TEST-WT-${(w.n % 3) + 1}`,
    estimatedTotalCost: w.cost, dateRequested: w.dateRequested, dateTradeAssigned: w.dateTradeAssigned, targetDate: w.targetDate,
  }));
  const rfeLookup = new Map(rfeRows.map((r) => [r.code, { submittedOn: r.submitted, approvedOn: r.approved }]));
  const typed = new Map(wrs.map((w) => [w.wrCode, { status: w.status, fcRemarks: w.fcRemarks || null }]));
  const master = buildMasterRows(pendingTyped, { today: REF, rfeLookup, typed });
  const summary = summarise(master, { today: REF });
  writeFileSync(join(OUT, 'tracker-master.xlsx'), await writeMasterWorkbook(master, summary, { asOf: REF }));

  // A second tracker with old / misspelt / unknown status spellings (for the status-mapping tests).
  const oldMaster = master.slice(0, 6).map((r, i) => ({
    ...r,
    status: ['work in progress - tdgi', 'Quote received RFE Yet to submit', 'Awaiting Material', 'Awaiting Approval', 'Pending for survey', 'Work in Progess - TDGI'][i],
  }));
  writeFileSync(join(OUT, 'tracker-master-old-spellings.xlsx'), await writeMasterWorkbook(oldMaster, summarise(oldMaster, { today: REF }), { asOf: REF }));

  writeFileSync(join(OUT, 'expected-counts.json'), JSON.stringify(expectedCounts(wrs), null, 2));

  writeFileSync(join(OUT, 'README.md'), readme(events, statusIdx.map((i) => changed[i].wrCode)));
  console.log(`Fixtures written to ${OUT}`);
}

function readme(events: { type: string; key: string; fields?: string[] }[], _s: string[]): string {
  const lines = events.map((e) => `| ${e.type} | ${e.key} | ${e.fields ? e.fields.join(', ') : ''} |`).join('\n');
  return `# SONU fixtures (synthetic)

Generated by \`npm run fixtures\` in \`packages/core\`. All values are fictional (requestors are "Requestor 001" ..., sites are
"Test Site <code>", contractor is "Test Contractor W.L.L."). Site codes and problem types are taken from the lookup table so that
every zone and discipline is covered; one row uses an unknown site (\`ZZZZ\`) and one an unknown problem type (\`XXXX\`) to test "Unmapped".
Reference date for all counts: **${REF}**. Fixed random seed, so a re-run produces the same content.

## Files

| File | What it is |
|---|---|
| pending-work-requests.xlsx | 60 work requests, exact 26 captions of Pending Work Requests, header on row 1. Row 60 has the code \`0100060\` (leading zero). |
| pending-work-requests.xls | The same data as a legacy .xls (BIFF8). |
| pending-work-requests-title-rows.xlsx | Same data with three title rows above the header (header on row 4). |
| pending-work-requests-renamed-column.xlsx | "Agreed Target Date" renamed to "Agreed Due Date": must be refused, naming the caption. |
| pending-work-requests-changed.xlsx | Second import of the same list, with the differences below. |
| review-approved-estimations.xlsx | 7 captions; RFE dates for part of the sample plus two older WRs; two rows have no approval date. |
| wr-dashboard.xlsx, estimate-and-schedule.xlsx, edit-update-wrs.xlsx, issue-wr.xlsx, rfe-post-box.xlsx, pending-rfe-status.xlsx, manage-permit-to-work.xlsx, end-to-end-wr-to-invoice.xlsx, boq-details.xlsx | Small files (4 to 8 rows) with the exact captions of each list. manage-permit-to-work has Date Upto at reference date -3, 0, +1, +2, +3, +10. |
| tracker-master.xlsx | The 60 work requests in the tracker layout (sheet "Status", header row 2), with contractor statuses, FC remarks and the computed columns as values, plus Statistics, Summary and Dashboard Data. |
| tracker-master-old-spellings.xlsx | Six rows with old / misspelt statuses (two are ambiguous or unknown). |
| expected-counts.json | Hand-countable tables for the sample at ${REF}, computed from the generator's own data (not by the library). |
| expected-events.json | The events that \`diffMirror(original, changed, 'pending_work_requests', { today })\` must give. |

## Differences between pending-work-requests.xlsx and pending-work-requests-changed.xlsx

Expected events (also in \`expected-events.json\`):

| Event | WR code | Changed fields |
|---|---|---|
${lines}

Everything else is identical, so a re-import of the same file raises no events at all.
A change of Work Request Status raises only \`wr.stage_changed\` (not also \`wr.changed\`); the WR that changed both status and target date raises both events.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
