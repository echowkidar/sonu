import { captionKey, readSheet, type BinaryInput } from './excel.js';
import { matchContractorStatus, type ContractorStatus } from './statuses.js';

/** Columns of the tracker's "Status" sheet, in the order of analysis 07 (header on row 2). */
export const TRACKER_MARAFIQ_COLUMNS = [
  'Date Work Requested',
  'Date Trade Assigned',
  'Work Request Code',
  'Requestor',
  'Site Code',
  'Site Name',
  'Building Code',
  'Building Name',
  'Problem Type',
  'Work Description',
  'Work Request Status',
  'Work Request Priority',
  'Work Team Code',
  'Estimated Total Cost',
  'Agreed Target Date',
] as const;

export const TRACKER_PEOPLE_COLUMNS = ['Status', 'FC Remarks'] as const;

export const TRACKER_COMPUTED_COLUMNS = [
  'Month',
  'Days to Breach',
  'TD Status',
  'KPI',
  'RFE Submitted ON',
  'RFE Approved on',
  'Discipline',
  'Facility',
  'Zone',
  'RFE status',
  'No Of Days Since requested',
  'RFE Status (time frame)',
] as const;

export const TRACKER_COLUMNS: readonly string[] = [
  ...TRACKER_MARAFIQ_COLUMNS,
  ...TRACKER_PEOPLE_COLUMNS,
  ...TRACKER_COMPUTED_COLUMNS,
];

export const TRACKER_SHEET = 'Status';
export const TRACKER_HEADER_ROW = 2;

export interface TrackerRow {
  wrCode: string;
  /** One of the 15 current statuses, or null when empty / not recognised. */
  status: ContractorStatus | null;
  /** The status text exactly as typed (trimmed). */
  rawStatus: string;
  fcRemarks: string;
}

export interface UnknownStatus {
  value: string;
  count: number;
  /** Current statuses it could mean (several = ambiguous, none = not recognised at all). */
  candidates: string[];
}

export type TrackerResult =
  | { ok: true; rows: TrackerRow[]; unknownStatuses: UnknownStatus[]; mapped: { from: string; to: string; count: number }[] }
  | { ok: false; rows: []; unknownStatuses: []; mapped: []; error: string };

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Read the contractor's tracker workbook: sheet "Status", header on row 2. Only the WR code, the typed Status and
 * FC Remarks are taken; everything else is recomputed by SONU. Old or misspelt statuses are mapped to the 15
 * current ones where that is unambiguous (case-insensitive); the rest are listed in `unknownStatuses`.
 */
export function parseTrackerWorkbook(buffer: BinaryInput): TrackerResult {
  const fail = (error: string): TrackerResult => ({ ok: false, rows: [], unknownStatuses: [], mapped: [], error });
  let sheet;
  try {
    sheet = readSheet(buffer, { sheet: TRACKER_SHEET, headerRow: TRACKER_HEADER_ROW });
  } catch (e) {
    return fail(`The file is not a readable workbook (${(e as Error).message}).`);
  }
  if (sheet.headerRow < 0) return fail(`The workbook has no sheet named "${TRACKER_SHEET}".`);
  const have = new Set(sheet.captions.map(captionKey));
  const need = ['Work Request Code', 'Status', 'FC Remarks'];
  const missing = need.filter((c) => !have.has(captionKey(c)));
  if (missing.length) {
    return fail(`Sheet "${TRACKER_SHEET}" row ${TRACKER_HEADER_ROW} is missing column${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}.`);
  }
  const keyOf = (cap: string) => Object.keys(sheet.rows[0] ?? {}).find((k) => captionKey(k) === captionKey(cap)) ?? cap;
  const kCode = keyOf('Work Request Code');
  const kStatus = keyOf('Status');
  const kRem = keyOf('FC Remarks');

  const rows: TrackerRow[] = [];
  const unknown = new Map<string, UnknownStatus>();
  const mapped = new Map<string, { from: string; to: string; count: number }>();
  for (const r of sheet.rows) {
    const wrCode = str(r[kCode]);
    if (!wrCode) continue;
    const rawStatus = str(r[kStatus]);
    const m = matchContractorStatus(rawStatus);
    let status: ContractorStatus | null = null;
    if (m.kind === 'exact') status = m.status;
    else if (m.kind === 'mapped') {
      status = m.status;
      const k = `${rawStatus}\u0000${m.status}`;
      const e = mapped.get(k) ?? { from: rawStatus, to: m.status, count: 0 };
      e.count++;
      mapped.set(k, e);
    } else if (m.kind === 'unknown') {
      const e = unknown.get(rawStatus.toLowerCase()) ?? { value: rawStatus, count: 0, candidates: m.candidates };
      e.count++;
      unknown.set(rawStatus.toLowerCase(), e);
    }
    rows.push({ wrCode, status, rawStatus, fcRemarks: str(r[kRem]) });
  }
  return { ok: true, rows, unknownStatuses: [...unknown.values()], mapped: [...mapped.values()] };
}
