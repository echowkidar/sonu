import { parseDateCell } from './dates.js';
import { captionKey, normaliseCaption, readSheet, setDefaultKnownCaptions, type BinaryInput } from './excel.js';
import * as C from './captions.generated.js';

export type ListKey =
  | 'pending_work_requests'
  | 'review_approved_estimations'
  | 'wr_dashboard'
  | 'estimate_and_schedule'
  | 'edit_update_wrs'
  | 'issue_wr'
  | 'rfe_post_box'
  | 'pending_rfe_status'
  | 'manage_permit_to_work'
  | 'end_to_end_wr_to_invoice'
  | 'boq_details';

export type ColumnType = 'string' | 'date' | 'number';

export interface ColumnDef {
  caption: string;
  /** Property name in the typed row (camelCase). */
  field: string;
  type: ColumnType;
}

export interface ExportDef {
  key: ListKey;
  title: string;
  menuPath: string;
  /** Exact captions in screen order. */
  captions: string[];
  /** Captions that must be present, otherwise the whole file is refused. */
  required: string[];
  /** Caption of the column that identifies a row (rows without it are skipped). */
  keyColumn: string;
  /** Typed definition of every caption. */
  columns: ColumnDef[];
  /** true when several rows may share the key (line-item exports). */
  multiRow: boolean;
}

/** Typed, normalised row. Dates are ISO `YYYY-MM-DD`, money/quantities are numbers, everything else trimmed strings. */
export type TypedRow = { [field: string]: string | number | null };

export function fieldName(caption: string): string {
  const words = caption
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
}

function build(
  key: ListKey,
  title: string,
  menuPath: string,
  captions: string[],
  keyColumn: string,
  opts: {
    dates?: string[];
    numbers?: string[];
    names?: Record<string, string>;
    required?: string[];
    multiRow?: boolean;
  } = {},
): ExportDef {
  const dates = new Set((opts.dates ?? []).map(captionKey));
  const numbers = new Set((opts.numbers ?? []).map(captionKey));
  const seen = new Set<string>();
  const columns: ColumnDef[] = captions.map((caption) => {
    const type: ColumnType = dates.has(captionKey(caption)) ? 'date' : numbers.has(captionKey(caption)) ? 'number' : 'string';
    let field = opts.names?.[caption] ?? fieldName(caption);
    while (seen.has(field)) field += '2';
    seen.add(field);
    return { caption, field, type };
  });
  for (const c of [...(opts.dates ?? []), ...(opts.numbers ?? []), keyColumn, ...(opts.required ?? [])]) {
    if (!captions.some((x) => captionKey(x) === captionKey(c))) throw new Error(`Export ${key}: unknown caption ${c}`);
  }
  return {
    key,
    title,
    menuPath,
    captions,
    required: opts.required ?? captions,
    keyColumn,
    columns,
    multiRow: opts.multiRow ?? false,
  };
}

// 03b lists "Pending Work Requests" twice (an XLS grid "Details of Pending On Demand Work Requests" with 26
// columns and a DOCX/PDF grid "On Demand Work Requests Statistics" with 3). The 26-column XLS grid is used.
const pending = build('pending_work_requests', 'Pending Work Requests', C.MENU_PENDING_WORK_REQUESTS, C.CAPTIONS_PENDING_WORK_REQUESTS, 'Work Request Code', {
  dates: ['Date Work Requested', 'Agreed Target Date', 'Date Trade Assigned'],
  numbers: ['Estimated Total Cost'],
  names: {
    'Work Request Code': 'wrCode',
    'Work Request Status': 'wrStatus',
    'Service Request Code': 'serviceRequestCode',
    'Permit to Work Code': 'ptwCode',
    'Permit to Work Status': 'ptwStatus',
    'Requestor Name': 'requestor',
    'Work Request Priority': 'priority',
    'WR Description': 'description',
    'Date Work Requested': 'dateRequested',
    'Agreed Target Date': 'targetDate',
    'Date Trade Assigned': 'dateTradeAssigned',
    'Estimated Total Cost': 'estimatedTotalCost',
    'Problem Type': 'problemType',
    'Problem Type Description': 'problemTypeDescription',
    'Work Team Code': 'workTeamCode',
    'Site Code': 'siteCode',
    'Site Name': 'siteName',
    'Building Code': 'buildingCode',
    'Building Name': 'buildingName',
  },
});

const approved = build('review_approved_estimations', 'Review Approved Estimations', C.MENU_REVIEW_APPROVED_ESTIMATIONS, C.CAPTIONS_REVIEW_APPROVED_ESTIMATIONS, 'Work Request Code', {
  dates: ['RFE Submitted On', 'RFE Approved On'],
  names: {
    'Work Request Code': 'wrCode',
    'Site Code': 'siteCode',
    'Building Code': 'buildingCode',
    'RFE Submitted On': 'rfeSubmittedOn',
    'RFE Approved On': 'rfeApprovedOn',
    'Work Team Code': 'workTeamCode',
    'Work Description': 'description',
  },
});

// WR Dashboard: the 22-column list that opens when a number is clicked. It is NOT in 03b; the captions are those
// of grid "Details of Pending On Demand Work Requests" in analysis/screens/qf-wr-custom-status-dashboard.md
// (also described in analysis/03 section 3 as "22 columns incl. WR Descriptive Status").
const WR_DASHBOARD_CAPTIONS = [
  'Action Item ID', 'Assigned to Work Order', 'Work Request Code', 'Site Code', 'Site Name', 'Building Code',
  'Building Name', 'Floor Code', 'Room Code', 'Equipment Code', 'Date Work Requested', 'Agreed Target Date',
  'Date Trade Assigned', 'Requested by', 'Problem Type', 'Work Request Priority', 'Estimated Total Cost',
  'Work Team Code', 'Contractor', 'Work Request Status', 'WR Descriptive Status', 'Work Description',
];
const dashboard = build('wr_dashboard', 'WR Dashboard list', 'Home > WR Dashboard (click a number)', WR_DASHBOARD_CAPTIONS, 'Work Request Code', {
  dates: ['Date Work Requested', 'Agreed Target Date', 'Date Trade Assigned'],
  numbers: ['Estimated Total Cost'],
  names: {
    'Work Request Code': 'wrCode',
    'Work Request Status': 'wrStatus',
    'WR Descriptive Status': 'descriptiveStatus',
    'Date Work Requested': 'dateRequested',
    'Agreed Target Date': 'targetDate',
    'Date Trade Assigned': 'dateTradeAssigned',
    'Estimated Total Cost': 'estimatedTotalCost',
    'Requested by': 'requestor',
    'Work Description': 'description',
  },
});

const estimate = build('estimate_and_schedule', 'Estimate and Schedule On Demand WRs', C.MENU_ESTIMATE_AND_SCHEDULE, C.CAPTIONS_ESTIMATE_AND_SCHEDULE, 'Work Request Code', {
  dates: ['Date Work Requested', 'Date Assigned'],
  numbers: ['Estimated Total Cost'],
  names: { 'Work Request Code': 'wrCode' },
});

// 03b lists "Edit / Update WRs" under both Contractor (WR) and Preventive Maintenance > Contractor (PPM);
// the Corrective Maintenance (on-demand) grid with 28 columns is used, not the PPM one.
const edit = build('edit_update_wrs', 'Edit / Update WRs (on demand)', C.MENU_EDIT_UPDATE_WRS, C.CAPTIONS_EDIT_UPDATE_WRS, 'Work Request Code', {
  dates: ['Date Work Requested', 'Date to Perform', 'Agreed Target Date'],
  numbers: ['% Progress', 'Estimated Labor Hours', 'Actual Labor Hours'],
  names: { 'Work Request Code': 'wrCode' },
});

// "Issue WR" also exists for PPM (19 columns); the on-demand grid with 24 columns is used.
const issue = build('issue_wr', 'Issue WR - Create E-PTW / Start the Work (on demand)', C.MENU_ISSUE_WR, C.CAPTIONS_ISSUE_WR, 'Work Request Code', {
  dates: ['Date Work Requested', 'Date to Perform', 'Agreed Target Date'],
  names: { 'Work Request Code': 'wrCode' },
});

const postBox = build('rfe_post_box', 'RFE Post Box', C.MENU_RFE_POST_BOX, C.CAPTIONS_RFE_POST_BOX, 'Other Res. Log ID', {
  dates: ['Date Used', 'Date Created'],
  numbers: ['Quantity Estimated', 'Estimated Cost'],
  names: { 'Other Res. Log ID': 'logId', 'Work Request Code': 'wrCode' },
});

const pendingRfe = build('pending_rfe_status', 'Pending RFE Status Report', C.MENU_PENDING_RFE_STATUS, C.CAPTIONS_PENDING_RFE_STATUS, 'Work Request Code', {
  dates: ['Date Work Requested', 'Date RFE Submitted'],
  numbers: ['RFE Amount', 'Total Amount'],
  names: { 'Work Request Code': 'wrCode' },
});

const permits = build('manage_permit_to_work', 'Manage Permit to Work', C.MENU_MANAGE_PERMIT_TO_WORK, C.CAPTIONS_MANAGE_PERMIT_TO_WORK, 'Permit to Work Code', {
  dates: ['Date Created', 'Date Issued', 'Date Start', 'Date Upto'],
  names: { 'Permit to Work Code': 'ptwCode', 'Permit to Work Status': 'ptwStatus', 'Date Upto': 'dateUpto' },
});

// 03b has three "End to end" lists (WR to Invoice 39 columns, PPM WR to Invoice 34, by group 17); the WR to
// Invoice one is used.
const e2e = build('end_to_end_wr_to_invoice', 'End to End details from WR to Invoice', C.MENU_END_TO_END_WR_TO_INVOICE, C.CAPTIONS_END_TO_END_WR_TO_INVOICE, 'Work Request Code', {
  dates: ['Date WR Estimated', 'Date Created', 'PO Date', 'PR Date', 'WCC Completion Date'],
  numbers: ['Quantity Estimated', 'Actual Quantity', 'Unit Cost', 'Cost Estimated', 'Cost Actual'],
  names: { 'Work Request Code': 'wrCode' },
  multiRow: true,
  // The rows are line items; only the identifying and money-trail columns must be present.
  required: [
    'Work Request Code', 'Work Request Status', 'Demand Note', 'PO Number', 'PO Status', 'PR Number', 'PR Status',
    'WCC Number', 'WCC Status', 'Invoice Number', 'invoice status',
  ],
});

const boq = build('boq_details', 'BOQ Details for BPA Release', C.MENU_BOQ_DETAILS, C.CAPTIONS_BOQ_DETAILS, 'Work Request Code', {
  dates: ['Date Work Assigned', 'Date Work Completed', 'Date Work Performed'],
  numbers: ['Unit Cost', 'Estimated Cost', 'Actual Cost', 'Estimated Hours', 'Quantity / Actual Hours'],
  names: { 'Work Request Code': 'wrCode' },
  multiRow: true,
  required: ['Work Request Code', 'Work Request Status', 'Account Code', 'BPA Agreement No', 'Line No', 'Estimated Cost', 'Actual Cost'],
});

export const EXPORTS: Record<ListKey, ExportDef> = {
  pending_work_requests: pending,
  review_approved_estimations: approved,
  wr_dashboard: dashboard,
  estimate_and_schedule: estimate,
  edit_update_wrs: edit,
  issue_wr: issue,
  rfe_post_box: postBox,
  pending_rfe_status: pendingRfe,
  manage_permit_to_work: permits,
  end_to_end_wr_to_invoice: e2e,
  boq_details: boq,
};

export const LIST_KEYS = Object.keys(EXPORTS) as ListKey[];

setDefaultKnownCaptions([...new Set(LIST_KEYS.flatMap((k) => EXPORTS[k].captions))]);

export interface DetectResult {
  key: ListKey | null;
  /** All lists scoring above the threshold, best first. */
  candidates: { key: ListKey; score: number; matched: number; missing: string[] }[];
  ambiguous: boolean;
}

/**
 * Score = Jaccard similarity between the file's captions and the export's captions (case-insensitive,
 * whitespace-normalised). A list is a candidate from 0.6. If the best two are within 0.05 of each other
 * the answer is ambiguous (key = null). A file with one renamed caption still scores about 0.9 and is
 * detected, so that parseExport can then name the missing caption.
 */
export function detectExportDetailed(captions: string[]): DetectResult {
  const have = new Set(captions.map(captionKey));
  const cands: DetectResult['candidates'] = [];
  for (const key of LIST_KEYS) {
    const wantSet = new Set(EXPORTS[key].captions.map(captionKey));
    const matched = [...wantSet].filter((c) => have.has(c)).length;
    const union = new Set([...have, ...wantSet]).size;
    const score = union === 0 ? 0 : matched / union;
    if (score >= 0.6) {
      cands.push({ key, score, matched, missing: EXPORTS[key].captions.filter((c) => !have.has(captionKey(c))) });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  if (cands.length === 0) return { key: null, candidates: [], ambiguous: false };
  const ambiguous = cands.length > 1 && cands[0].score - cands[1].score < 0.05;
  return { key: ambiguous ? null : cands[0].key, candidates: cands, ambiguous };
}

/** Best matching export for a set of captions, or null (nothing close enough, or ambiguous). */
export function detectExport(captions: string[]): ListKey | null {
  return detectExportDetailed(captions).key;
}

export type ParseResult =
  | { ok: true; listKey: ListKey; rows: TypedRow[]; rowsRead: number; warnings: string[] }
  | {
      ok: false;
      error: { code: 'MISSING_CAPTION' | 'UNKNOWN_FILE' | 'EMPTY'; missingCaptions: string[]; message: string };
    };

function cleanString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return parseDateCell(v).value;
  if (typeof v === 'number') return String(v);
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

function cleanNumber(v: unknown): { ok: boolean; value: number | null } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, value: null };
  const s = String(v).trim();
  if (s === '' || s === '-') return { ok: true, value: null };
  const t = s.replace(/[\s,]/g, '').replace(/^(QR|QAR)/i, '').replace(/%$/, '');
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  return { ok: false, value: null };
}

/**
 * Read a file as the given export. All-or-nothing: if any required caption is missing (for example because
 * Marafiq renamed it) nothing is returned except the error naming the caption(s).
 */
export function parseExport(listKey: ListKey, buffer: BinaryInput, fileName?: string): ParseResult {
  const def = EXPORTS[listKey];
  if (!def) {
    return { ok: false, error: { code: 'UNKNOWN_FILE', missingCaptions: [], message: `Unknown list "${String(listKey)}".` } };
  }
  const label = fileName ? `"${fileName}"` : 'The file';
  let sheet;
  try {
    sheet = readSheet(buffer, { knownCaptions: def.captions });
  } catch (e) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_FILE', missingCaptions: [], message: `${label} is not a readable .xlsx or .xls workbook (${(e as Error).message}).` },
    };
  }
  if (sheet.headerRow < 0) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_FILE',
        missingCaptions: [],
        message: `${label} does not look like the "${def.title}" export: no header row with its column captions was found.`,
      },
    };
  }
  const have = new Set(sheet.captions.map(captionKey));
  const missing = def.required.filter((c) => !have.has(captionKey(c)));
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'MISSING_CAPTION',
        missingCaptions: missing,
        message: `${label} cannot be imported as "${def.title}": missing column${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}. Nothing was loaded.`,
      },
    };
  }
  if (sheet.rows.length === 0) {
    return { ok: false, error: { code: 'EMPTY', missingCaptions: [], message: `${label} has the right columns but no data rows.` } };
  }

  // Map the file's actual header text to our column definitions (first occurrence of a duplicated caption only).
  const colByKey = new Map(def.columns.map((c) => [captionKey(c.caption), c]));
  const colForFileKey = new Map<string, ColumnDef>();
  for (const k of Object.keys(sheet.rows[0] ?? {})) {
    const col = colByKey.get(captionKey(k));
    if (col) colForFileKey.set(k, col);
  }

  const warnings: string[] = [];
  const rows: TypedRow[] = [];
  const keyCol = def.columns.find((c) => captionKey(c.caption) === captionKey(def.keyColumn))!;
  sheet.rows.forEach((raw, i) => {
    const rowNo = sheet.rowNumbers[i];
    const typed: TypedRow = {};
    for (const col of def.columns) typed[col.field] = null;
    for (const [fileKey, col] of colForFileKey) {
      const v = raw[fileKey];
      if (col.type === 'string') typed[col.field] = cleanString(v);
      else if (col.type === 'date') {
        const r = parseDateCell(v);
        if (!r.ok) warnings.push(`Row ${rowNo}: "${col.caption}" is not a recognised date (${JSON.stringify(v)}); left empty.`);
        typed[col.field] = r.value;
      } else {
        const r = cleanNumber(v);
        if (!r.ok) warnings.push(`Row ${rowNo}: "${col.caption}" is not a number (${JSON.stringify(v)}); left empty.`);
        typed[col.field] = r.value;
      }
    }
    if (typed[keyCol.field] === null) {
      warnings.push(`Row ${rowNo}: no "${def.keyColumn}"; row skipped.`);
      return;
    }
    rows.push(typed);
  });
  if (!def.multiRow) {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = String(r[keyCol.field]);
      if (seen.has(k)) warnings.push(`Duplicate "${def.keyColumn}" ${k}: both rows are kept; the later one wins when compared.`);
      seen.add(k);
    }
  }
  return { ok: true, listKey, rows, rowsRead: sheet.rows.length, warnings };
}

export { normaliseCaption };
