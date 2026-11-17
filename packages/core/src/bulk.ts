import * as XLSX from 'xlsx';
import { captionKey, normaliseCaption, readWorkbook, sheetMatrix, type BinaryInput } from './excel.js';

/**
 * Preview parser for the three bulk-import templates (design 14 section 8, files in assets/SONU-import-*.xlsx).
 * Row 1 = captions (`*` = compulsory), row 2 = the EXAMPLE row, data from row 3. Nothing here saves anything:
 * it returns every row with its values and the problems per cell.
 */

export type BulkKind = 'contractors' | 'users' | 'subcontractors';

export interface RowProblem {
  /** Caption without the `*`. */
  column: string;
  reason: string;
}

export interface BulkRow {
  /** 1-based row number in the sheet. */
  rowNumber: number;
  /** Values by caption (without `*`): trimmed strings, numbers as numbers; e-mail lower-cased; mobile as `+<digits>`. */
  values: Record<string, string | number | null>;
  problems: RowProblem[];
}

export type BulkResult =
  | { ok: true; sheets: Record<string, { rows: BulkRow[] }>; skippedExamples: number; error?: undefined }
  | { ok: false; sheets: Record<string, { rows: BulkRow[] }>; skippedExamples: number; error: string };

interface ColSpec {
  caption: string;
  required: boolean;
  /** Header text of the column in the sheet "Lists" that holds the allowed values (the cell is a drop-down in the template). */
  list?: string;
  /** Allowed values used when the file carries no Lists sheet. */
  fallback?: string[];
  type?: 'email' | 'mobile' | 'url' | 'int' | 'timezone' | 'multi';
  /** For `multi`: every semicolon-separated item must be in the list. */
  multi?: boolean;
  /** Duplicate values in this column are problems. */
  unique?: boolean;
}

interface SheetSpec {
  name: string;
  columns: ColSpec[];
  /** The caption whose value starting with EXAMPLE marks a row to ignore. */
  codeColumn: string;
  /** Extra duplicate check over several columns (e.g. contact = code + mobile). */
  uniqueTogether?: string[];
}

const YES_NO = ['Yes', 'No'];

const SPECS: Record<BulkKind, SheetSpec[]> = {
  contractors: [
    {
      name: 'Contractors',
      codeColumn: 'Contractor Code',
      columns: [
        { caption: 'Contractor Code', required: true, unique: true },
        { caption: 'Company Name', required: true },
        { caption: 'Company Name (Arabic)', required: false },
        { caption: 'Marafiq Trade Code', required: false },
        { caption: 'Marafiq Work Teams', required: false },
        { caption: 'Disciplines', required: false },
        { caption: 'Admin Name', required: true },
        { caption: 'Admin Email', required: true, type: 'email' },
        { caption: 'Admin Mobile', required: false, type: 'mobile' },
        { caption: 'Sender Email', required: false, type: 'email' },
        { caption: 'Time Zone', required: false, type: 'timezone' },
        { caption: 'Status', required: true, list: 'Status', fallback: ['Active', 'Inactive'] },
        { caption: 'Notes', required: false },
      ],
    },
  ],
  users: [
    {
      name: 'Users',
      codeColumn: 'Contractor Code',
      columns: [
        { caption: 'Contractor Code', required: true },
        { caption: 'Full Name', required: true },
        { caption: 'Email', required: true, type: 'email', unique: true },
        { caption: 'Mobile', required: false, type: 'mobile' },
        { caption: 'Role', required: true, list: 'Role', fallback: ['Technician', 'Foreman', 'Supervisor', 'Coordinator', 'Purchasing', 'Manager', 'Contractor Admin'] },
        { caption: 'Work Teams', required: false },
        { caption: 'Discipline', required: false },
        { caption: 'Employee No', required: false },
        { caption: 'Marafiq Craftsperson Code', required: false },
        { caption: 'Language', required: false, list: 'Language', fallback: ['English', 'Arabic', 'Hindi'] },
        { caption: 'Notify by Email', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Notify by Push', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Notify by WhatsApp', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Reports To (Email)', required: false, type: 'email' },
        { caption: 'Status', required: true, list: 'Status', fallback: ['Active', 'Inactive'] },
      ],
    },
  ],
  subcontractors: [
    {
      name: 'SubContractors',
      codeColumn: 'Sub-contractor Code',
      columns: [
        { caption: 'Contractor Code', required: true },
        { caption: 'Sub-contractor Code', required: true, unique: true },
        { caption: 'Company Name', required: true },
        { caption: 'Company Name (Arabic)', required: false },
        { caption: 'CR Number', required: false },
        { caption: 'Categories', required: true, list: 'Categories', type: 'multi', multi: true },
        { caption: 'Zones Served', required: false },
        { caption: 'Address', required: false },
        { caption: 'Website', required: false, type: 'url' },
        { caption: 'Payment Terms', required: false },
        { caption: 'Emergency Call-out', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Status', required: true, list: 'Sub-contractor status', fallback: ['Pending verification', 'Verified', 'Suspended', 'Blocked'] },
        { caption: 'Notes', required: false },
      ],
    },
    {
      name: 'Contacts',
      codeColumn: 'Sub-contractor Code',
      uniqueTogether: ['Sub-contractor Code', 'Mobile'],
      columns: [
        { caption: 'Sub-contractor Code', required: true },
        { caption: 'Contact Name', required: true },
        { caption: 'Role', required: false, list: 'Contact role', fallback: ['Sales', 'Estimator', 'Site Supervisor', 'Manager', 'Accounts'] },
        { caption: 'Mobile', required: true, type: 'mobile' },
        { caption: 'WhatsApp Number', required: false, type: 'mobile' },
        { caption: 'Email', required: false, type: 'email' },
        { caption: 'Preferred Channel', required: false, list: 'Channel', fallback: ['WhatsApp', 'Email', 'SMS', 'Call', 'Push'] },
        { caption: 'Language', required: false, list: 'Language', fallback: ['English', 'Arabic', 'Hindi'] },
        { caption: 'Receives Enquiries', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Receives Urgent Calls', required: false, list: 'Yes/No', fallback: YES_NO },
        { caption: 'Escalation Order', required: false, type: 'int' },
        { caption: 'Consent to Messages', required: false, list: 'Yes/No', fallback: YES_NO },
      ],
    },
  ],
};

/** Any header that looks like it could hold a password makes the whole file fail. */
export const SECRET_CAPTION_RE = /pass(word)?|pwd|secret/i;

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).replace(/\s+/g, ' ').trim();
};

/** Mobile with country code: `+` or `00` and 8-15 digits (spaces, dashes, brackets, dots ignored). Returns `+<digits>` or null. */
export function normaliseMobile(raw: string): string | null {
  let s = raw.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readLists(wb: XLSX.WorkBook): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const name = wb.SheetNames.find((n) => n.toLowerCase() === 'lists');
  if (!name) return out;
  const m = sheetMatrix(wb.Sheets[name]);
  const head = m[0] ?? [];
  head.forEach((h, c) => {
    const key = cell(h);
    if (!key) return;
    const vals: string[] = [];
    for (let r = 1; r < m.length; r++) {
      const v = cell(m[r]?.[c]);
      if (v) vals.push(v);
    }
    out.set(key.toLowerCase(), vals);
  });
  return out;
}

/**
 * Read a filled bulk-import template.
 *  - Any header that matches /pass(word)?|pwd|secret/i on a data sheet fails the whole file.
 *  - Rows whose code starts with EXAMPLE are skipped (counted in `skippedExamples`); empty rows are ignored.
 *  - Per cell problems: compulsory (`*`) value missing, value not in the drop-down list, bad e-mail, mobile without
 *    country code, duplicate code / e-mail inside the file.
 */
export function parseBulkTemplate(kind: BulkKind, buffer: BinaryInput): BulkResult {
  const specs = SPECS[kind];
  const empty: BulkResult = { ok: false, sheets: {}, skippedExamples: 0, error: '' };
  if (!specs) return { ...empty, error: `Unknown import kind "${String(kind)}".` };
  let wb: XLSX.WorkBook;
  try {
    wb = readWorkbook(buffer);
  } catch (e) {
    return { ...empty, error: `The file is not a readable Excel workbook (${(e as Error).message}).` };
  }

  // 1. Password-looking captions: refuse the whole file before anything else.
  const dataSheetNames = new Set(specs.map((s) => s.name.toLowerCase()));
  for (const name of wb.SheetNames) {
    if (!dataSheetNames.has(name.toLowerCase())) continue;
    const head = sheetMatrix(wb.Sheets[name])[0] ?? [];
    const bad = head.map(cell).find((h) => h && SECRET_CAPTION_RE.test(h));
    if (bad) {
      return {
        ...empty,
        error: `Column "${bad}" on sheet "${name}" looks like a password. Passwords are never imported from Excel - remove the column and set passwords in the admin panel (users set their own from the invitation link). Nothing was read.`,
      };
    }
  }

  const lists = readLists(wb);
  const sheets: Record<string, { rows: BulkRow[] }> = {};
  let skippedExamples = 0;

  for (const spec of specs) {
    const wsName = wb.SheetNames.find((n) => n.toLowerCase() === spec.name.toLowerCase());
    if (!wsName) return { ...empty, error: `Sheet "${spec.name}" is missing. Use the SONU template for ${kind}.` };
    const matrix = sheetMatrix(wb.Sheets[wsName]);
    const headerCells = (matrix[0] ?? []).map(cell);
    const colIndex = new Map<string, number>();
    headerCells.forEach((h, i) => {
      if (h) colIndex.set(captionKey(h.replace(/\*+$/, '')), i);
    });
    const missingCols = spec.columns.filter((c) => !colIndex.has(captionKey(c.caption))).map((c) => c.caption);
    if (missingCols.length) {
      return { ...empty, error: `Sheet "${spec.name}" is missing column${missingCols.length > 1 ? 's' : ''} ${missingCols.map((m) => `"${m}"`).join(', ')}. Use the SONU template for ${kind}.` };
    }
    // A compulsory column must still be marked with * in the header? Not enforced: the caption without * is what counts.

    const rows: BulkRow[] = [];
    const seenUnique = new Map<string, Map<string, number>>();
    const seenTogether = new Map<string, number>();
    for (let r = 1; r < matrix.length; r++) {
      const line = matrix[r];
      if (!line || line.every((v) => cell(v) === '')) continue;
      const values: Record<string, string | number | null> = {};
      for (const col of spec.columns) {
        const raw = line[colIndex.get(captionKey(col.caption))!];
        const s = cell(raw);
        values[col.caption] = s === '' ? null : typeof raw === 'number' && col.type === 'int' ? raw : s;
      }
      const code = String(values[spec.codeColumn] ?? '');
      if (/^EXAMPLE/i.test(code)) {
        skippedExamples++;
        continue;
      }
      const problems: RowProblem[] = [];
      const bad = (column: string, reason: string) => problems.push({ column, reason });

      for (const col of spec.columns) {
        const v = values[col.caption];
        const text = v === null ? '' : String(v);
        if (text === '') {
          if (col.required) bad(col.caption, 'Compulsory value is missing.');
          continue;
        }
        // Allowed values from the file's own Lists sheet (the drop-down source), else the template's defaults.
        if (col.list) {
          const allowed = lists.get(col.list.toLowerCase()) ?? col.fallback;
          if (allowed && allowed.length) {
            const items = col.multi ? text.split(';').map((x) => x.trim()).filter(Boolean) : [text];
            const lower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
            const fixed: string[] = [];
            for (const it of items) {
              const hit = lower.get(it.toLowerCase());
              if (!hit) bad(col.caption, `"${it}" is not in the list of allowed values (${allowed.slice(0, 8).join(', ')}${allowed.length > 8 ? ', ...' : ''}).`);
              else fixed.push(hit);
            }
            if (fixed.length === items.length) values[col.caption] = fixed.join('; ');
          }
        }
        if (col.type === 'email') {
          if (!EMAIL_RE.test(text)) bad(col.caption, `"${text}" is not a valid e-mail address.`);
          else values[col.caption] = text.toLowerCase();
        } else if (col.type === 'mobile') {
          const m = normaliseMobile(text);
          if (!m) bad(col.caption, `"${text}" is not a mobile number with country code (for example +97455550100).`);
          else values[col.caption] = m;
        } else if (col.type === 'url') {
          if (!/^https?:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(text)) bad(col.caption, `"${text}" is not a web address starting with http:// or https://.`);
        } else if (col.type === 'int') {
          if (!/^\d+$/.test(text) || Number(text) < 1) bad(col.caption, `"${text}" must be a whole number from 1.`);
          else values[col.caption] = Number(text);
        } else if (col.type === 'timezone') {
          if (!validTimeZone(text)) bad(col.caption, `"${text}" is not a time zone name such as Asia/Qatar.`);
        }
        if (col.unique) {
          const key = String(values[col.caption]).toLowerCase();
          const map = seenUnique.get(col.caption) ?? new Map<string, number>();
          seenUnique.set(col.caption, map);
          const first = map.get(key);
          if (first !== undefined) bad(col.caption, `Duplicate of row ${first} in this file.`);
          else map.set(key, r + 1);
        }
      }
      if (spec.uniqueTogether) {
        const parts = spec.uniqueTogether.map((c) => String(values[c] ?? '').toLowerCase());
        if (parts.every(Boolean)) {
          const key = parts.join('|');
          const first = seenTogether.get(key);
          if (first !== undefined) bad(spec.uniqueTogether[spec.uniqueTogether.length - 1], `Duplicate of row ${first}: same ${spec.uniqueTogether.join(' + ')}.`);
          else seenTogether.set(key, r + 1);
        }
      }
      rows.push({ rowNumber: r + 1, values, problems });
    }
    sheets[spec.name] = { rows };
  }
  return { ok: true, sheets, skippedExamples };
}

export { normaliseCaption };
