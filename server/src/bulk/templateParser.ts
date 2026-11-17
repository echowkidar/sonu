/**
 * Bulk-import template parsing (contractors / users / sub-contractors).
 *
 * LOCAL STAND-IN: the canonical implementation is planned in @sonu/core
 * (`parseBulkTemplate(kind, buffer)`). This file keeps the server unblocked; the lead may swap
 * `defaultBulkParser` for an adapter around core later. Keep the BulkTemplateParser interface.
 *
 * Rules (design 14 §8): row 1 = captions, `*` marks compulsory columns, row 2 is an EXAMPLE row,
 * data from row 3. Rows whose code starts with "EXAMPLE" are skipped. Allowed values for drop-down
 * columns come from the Lists sheet of the reference templates in assets/. Any column whose caption
 * looks like a password rejects the whole file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

export type BulkKind = 'contractors' | 'users' | 'subcontractors';
export const BULK_KINDS: readonly BulkKind[] = ['contractors', 'users', 'subcontractors'];

export type BulkValue = string | number | boolean | string[] | null;

export interface BulkProblem {
  /** Caption of the column (without *), or "(row)" for row-level problems. */
  column: string;
  reason: string;
}

export interface BulkRow {
  sheet: string;
  rowNumber: number;
  /** Parsed values keyed by field name (see TEMPLATE_SPECS). */
  values: Record<string, BulkValue>;
  /** Original cell text keyed by caption (used for the rejected-rows file). */
  raw: Record<string, string>;
  problems: BulkProblem[];
}

export interface BulkFileProblem {
  code: 'password_column' | 'missing_sheet' | 'missing_column' | 'unreadable' | 'empty';
  message: string;
  sheet?: string;
  column?: string;
}

export interface BulkParseResult {
  kind: BulkKind;
  rows: BulkRow[];
  skippedExamples: number;
  /** Non-empty = the whole file is refused (nothing previewed). */
  fileProblems: BulkFileProblem[];
}

export interface BulkTemplateParser {
  parse(kind: BulkKind, buffer: Buffer): Promise<BulkParseResult>;
}

// ───────────────────────────── Template description ─────────────────────────────

export type ColumnType = 'text' | 'code' | 'email' | 'mobile' | 'list' | 'multi' | 'yesno' | 'int' | 'url' | 'timezone';

export interface ColumnSpec {
  field: string;
  caption: string;
  required?: boolean;
  type: ColumnType;
  /** Header of the Lists-sheet column that holds the allowed values (list / multi). */
  list?: string;
  max?: number;
  /** Part of the key used to detect EXAMPLE rows. */
  exampleKey?: boolean;
}

export interface SheetSpec {
  sheet: string;
  columns: ColumnSpec[];
}

export const TEMPLATE_FILES: Record<BulkKind, string> = {
  contractors: 'SONU-import-contractors.xlsx',
  users: 'SONU-import-users.xlsx',
  subcontractors: 'SONU-import-subcontractors.xlsx',
};

export const TEMPLATE_SPECS: Record<BulkKind, SheetSpec[]> = {
  contractors: [
    {
      sheet: 'Contractors',
      columns: [
        { field: 'code', caption: 'Contractor Code', required: true, type: 'code', exampleKey: true },
        { field: 'name', caption: 'Company Name', required: true, type: 'text', max: 200 },
        { field: 'nameAr', caption: 'Company Name (Arabic)', type: 'text', max: 200 },
        { field: 'marafiqTradeCode', caption: 'Marafiq Trade Code', type: 'text', max: 60 },
        { field: 'marafiqWorkTeams', caption: 'Marafiq Work Teams', type: 'multi' },
        { field: 'disciplines', caption: 'Disciplines', type: 'multi' },
        { field: 'adminName', caption: 'Admin Name', required: true, type: 'text', max: 120 },
        { field: 'adminEmail', caption: 'Admin Email', required: true, type: 'email' },
        { field: 'adminMobile', caption: 'Admin Mobile', type: 'mobile' },
        { field: 'senderEmail', caption: 'Sender Email', type: 'email' },
        { field: 'timeZone', caption: 'Time Zone', type: 'timezone' },
        { field: 'status', caption: 'Status', required: true, type: 'list', list: 'Status' },
        { field: 'notes', caption: 'Notes', type: 'text', max: 5000 },
      ],
    },
  ],
  users: [
    {
      sheet: 'Users',
      columns: [
        { field: 'contractorCode', caption: 'Contractor Code', required: true, type: 'code', exampleKey: true },
        { field: 'fullName', caption: 'Full Name', required: true, type: 'text', max: 120 },
        { field: 'email', caption: 'Email', required: true, type: 'email' },
        { field: 'mobile', caption: 'Mobile', type: 'mobile' },
        { field: 'role', caption: 'Role', required: true, type: 'list', list: 'Role' },
        { field: 'workTeams', caption: 'Work Teams', type: 'multi' },
        { field: 'discipline', caption: 'Discipline', type: 'text', max: 60 },
        { field: 'employeeNo', caption: 'Employee No', type: 'text', max: 60 },
        { field: 'craftspersonCode', caption: 'Marafiq Craftsperson Code', type: 'text', max: 60 },
        { field: 'language', caption: 'Language', type: 'list', list: 'Language' },
        { field: 'notifyEmail', caption: 'Notify by Email', type: 'yesno' },
        { field: 'notifyPush', caption: 'Notify by Push', type: 'yesno' },
        { field: 'notifyWhatsapp', caption: 'Notify by WhatsApp', type: 'yesno' },
        { field: 'reportsTo', caption: 'Reports To (Email)', type: 'email' },
        { field: 'status', caption: 'Status', required: true, type: 'list', list: 'Status' },
      ],
    },
  ],
  subcontractors: [
    {
      sheet: 'SubContractors',
      columns: [
        { field: 'contractorCode', caption: 'Contractor Code', required: true, type: 'code', exampleKey: true },
        { field: 'code', caption: 'Sub-contractor Code', required: true, type: 'code', exampleKey: true },
        { field: 'name', caption: 'Company Name', required: true, type: 'text', max: 200 },
        { field: 'nameAr', caption: 'Company Name (Arabic)', type: 'text', max: 200 },
        { field: 'crNumber', caption: 'CR Number', type: 'text', max: 60 },
        { field: 'categories', caption: 'Categories', required: true, type: 'multi', list: 'Categories' },
        { field: 'zonesServed', caption: 'Zones Served', type: 'multi' },
        { field: 'address', caption: 'Address', type: 'text', max: 500 },
        { field: 'website', caption: 'Website', type: 'url' },
        { field: 'paymentTerms', caption: 'Payment Terms', type: 'text', max: 120 },
        { field: 'emergencyCallout', caption: 'Emergency Call-out', type: 'yesno' },
        { field: 'status', caption: 'Status', required: true, type: 'list', list: 'Sub-contractor status' },
        { field: 'notes', caption: 'Notes', type: 'text', max: 5000 },
      ],
    },
    {
      sheet: 'Contacts',
      columns: [
        { field: 'subcontractorCode', caption: 'Sub-contractor Code', required: true, type: 'code', exampleKey: true },
        { field: 'name', caption: 'Contact Name', required: true, type: 'text', max: 120 },
        { field: 'role', caption: 'Role', type: 'list', list: 'Contact role' },
        { field: 'mobile', caption: 'Mobile', required: true, type: 'mobile' },
        { field: 'whatsapp', caption: 'WhatsApp Number', type: 'mobile' },
        { field: 'email', caption: 'Email', type: 'email' },
        { field: 'preferredChannel', caption: 'Preferred Channel', type: 'list', list: 'Channel' },
        { field: 'language', caption: 'Language', type: 'list', list: 'Language' },
        { field: 'receivesEnquiries', caption: 'Receives Enquiries', type: 'yesno' },
        { field: 'receivesUrgent', caption: 'Receives Urgent Calls', type: 'yesno' },
        { field: 'escalationOrder', caption: 'Escalation Order', type: 'int' },
        { field: 'consent', caption: 'Consent to Messages', type: 'yesno' },
      ],
    },
  ],
};

/** Built-in allowed values, used only if the reference template cannot be read. */
const FALLBACK_LISTS: Record<BulkKind, Record<string, string[]>> = {
  contractors: { Status: ['Active', 'Inactive'] },
  users: {
    Role: ['Technician', 'Foreman', 'Supervisor', 'Coordinator', 'Purchasing', 'Manager', 'Contractor Admin'],
    Language: ['English', 'Arabic', 'Hindi'],
    Status: ['Active', 'Inactive'],
  },
  subcontractors: {
    'Sub-contractor status': ['Pending verification', 'Verified', 'Suspended', 'Blocked'],
    'Contact role': ['Sales', 'Estimator', 'Site Supervisor', 'Manager', 'Accounts'],
    Channel: ['WhatsApp', 'Email', 'SMS', 'Call', 'Push'],
    Language: ['English', 'Arabic', 'Hindi'],
  },
};

// ───────────────────────────── Helpers ─────────────────────────────

/** Captions that look like a password / secret column. */
export const PASSWORD_CAPTION = /pass\s*-?\s*word|passwd|\bpwd\b|\bpass\b|\bpin\b|secret|credential|token|كلمة\s*(ال)?(سر|مرور)/i;

export function normCaption(s: string): string {
  return s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Text of a cell whatever exceljs returns (rich text, hyperlink, formula result, date, number). */
export function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    if ('text' in o && o.text !== undefined) return cellText(o.text as ExcelJS.CellValue);
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('error' in o) return '';
  }
  return String(v).trim();
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitMulti(s: string): string[] {
  return s.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
}

function matchList(value: string, allowed: string[] | undefined): string | undefined {
  if (!allowed?.length) return value;
  const v = value.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v);
}

async function readListsSheet(wb: ExcelJS.Workbook): Promise<Record<string, string[]>> {
  const ws = wb.getWorksheet('Lists');
  const out: Record<string, string[]> = {};
  if (!ws) return out;
  const header = ws.getRow(1);
  header.eachCell((cell, col) => {
    const name = cellText(cell.value).replace(/\s*\(suggestions\)\s*$/i, '');
    if (!name) return;
    const vals: string[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const t = cellText(ws.getRow(r).getCell(col).value);
      if (t) vals.push(t);
    }
    out[name] = vals;
  });
  return out;
}

// ───────────────────────────── Parser ─────────────────────────────

export class ExcelJsBulkParser implements BulkTemplateParser {
  private readonly listCache = new Map<BulkKind, Record<string, string[]>>();

  /** assetsDir: folder with the reference templates (allowed values come from their Lists sheets). */
  constructor(private readonly assetsDir: string) {}

  async allowedValues(kind: BulkKind): Promise<Record<string, string[]>> {
    const cached = this.listCache.get(kind);
    if (cached) return cached;
    let lists: Record<string, string[]> = {};
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await fs.readFile(path.join(this.assetsDir, TEMPLATE_FILES[kind]))) as unknown as ExcelJS.Buffer);
      lists = await readListsSheet(wb);
    } catch {
      /* fall back below */
    }
    const merged = { ...FALLBACK_LISTS[kind], ...lists };
    this.listCache.set(kind, merged);
    return merged;
  }

  async parse(kind: BulkKind, buffer: Buffer): Promise<BulkParseResult> {
    const result: BulkParseResult = { kind, rows: [], skippedExamples: 0, fileProblems: [] };
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      result.fileProblems.push({ code: 'unreadable', message: 'The file could not be read as an Excel workbook (.xlsx).' });
      return result;
    }

    // 1) Password-looking captions anywhere in a data sheet → refuse the whole file.
    wb.eachSheet((ws) => {
      if (/^(instructions|lists)$/i.test(ws.name)) return;
      ws.getRow(1).eachCell((cell) => {
        const caption = cellText(cell.value).replace(/\*/g, '').trim();
        if (caption && PASSWORD_CAPTION.test(caption)) {
          result.fileProblems.push({
            code: 'password_column',
            sheet: ws.name,
            column: caption,
            message: `Column "${caption}" on sheet "${ws.name}" looks like a password. Passwords are never imported from Excel — delete the column and upload again. Users set their own password from the invitation link; Marafiq and mail passwords are typed in the admin panel.`,
          });
        }
      });
    });
    if (result.fileProblems.length) return result;

    const lists = await this.allowedValues(kind);

    for (const spec of TEMPLATE_SPECS[kind]) {
      const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === spec.sheet.toLowerCase());
      if (!ws) {
        result.fileProblems.push({ code: 'missing_sheet', sheet: spec.sheet, message: `Sheet "${spec.sheet}" is missing. Use the SONU template.` });
        continue;
      }
      const colIndex = new Map<string, number>();
      ws.getRow(1).eachCell((cell, col) => {
        const c = normCaption(cellText(cell.value));
        if (c && !colIndex.has(c)) colIndex.set(c, col);
      });
      const missing = spec.columns.filter((c) => c.required && !colIndex.has(normCaption(c.caption)));
      for (const m of missing) {
        result.fileProblems.push({ code: 'missing_column', sheet: spec.sheet, column: m.caption, message: `Compulsory column "${m.caption}" is missing on sheet "${spec.sheet}".` });
      }
      if (missing.length) continue;

      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const raw: Record<string, string> = {};
        let any = false;
        for (const c of spec.columns) {
          const idx = colIndex.get(normCaption(c.caption));
          const t = idx ? cellText(row.getCell(idx).value) : '';
          raw[c.caption] = t;
          if (t) any = true;
        }
        if (!any) continue;
        if (spec.columns.some((c) => c.exampleKey && /^example/i.test(raw[c.caption] ?? ''))) {
          result.skippedExamples++;
          continue;
        }
        const values: Record<string, BulkValue> = {};
        const problems: BulkProblem[] = [];
        for (const c of spec.columns) {
          const { value, problem } = convert(c, raw[c.caption] ?? '', lists);
          values[c.field] = value;
          if (problem) problems.push({ column: c.caption, reason: problem });
        }
        result.rows.push({ sheet: spec.sheet, rowNumber: r, values, raw, problems });
      }
    }
    if (!result.fileProblems.length && !result.rows.length) {
      result.fileProblems.push({ code: 'empty', message: 'The file has no data rows (the EXAMPLE row is ignored). Type your data from row 3.' });
    }
    return result;
  }
}

function convert(c: ColumnSpec, text: string, lists: Record<string, string[]>): { value: BulkValue; problem?: string } {
  if (!text) {
    if (c.required) return { value: c.type === 'multi' ? [] : null, problem: 'Compulsory — enter a value.' };
    return { value: c.type === 'multi' ? [] : null };
  }
  if (c.max && text.length > c.max) return { value: text, problem: `Too long (at most ${c.max} characters).` };
  switch (c.type) {
    case 'text':
      return { value: text };
    case 'code':
      return /^[A-Za-z0-9._-]{1,40}$/.test(text)
        ? { value: text }
        : { value: text, problem: 'Use letters, digits, dot, dash or underscore (at most 40), no spaces.' };
    case 'email': {
      const v = text.replace(/^mailto:/i, '').trim().toLowerCase();
      return EMAIL.test(v) && v.length <= 254 ? { value: v } : { value: text, problem: 'Not a valid e-mail address.' };
    }
    case 'mobile': {
      const v = text.replace(/[\s()-]/g, '');
      if (/^\+\d{8,15}$/.test(v)) return { value: v };
      if (/^\d{8,15}$/.test(v) && !v.startsWith('0')) return { value: `+${v}` }; // Excel drops the leading +
      return { value: text, problem: 'Mobile with country code, no spaces, e.g. +97455550100.' };
    }
    case 'list': {
      const m = matchList(text, c.list ? lists[c.list] : undefined);
      return m ? { value: m } : { value: text, problem: `Not an allowed value. Choose one of: ${(c.list ? lists[c.list] : [])?.join(', ')}.` };
    }
    case 'multi': {
      const items = splitMulti(text);
      if (c.required && !items.length) return { value: [], problem: 'Compulsory — enter a value.' };
      const allowed = c.list ? lists[c.list] : undefined;
      if (!allowed?.length) return { value: [...new Set(items)] };
      const out: string[] = [];
      const bad: string[] = [];
      for (const i of items) {
        const m = matchList(i, allowed);
        if (m) out.push(m);
        else bad.push(i);
      }
      return bad.length ? { value: out, problem: `Unknown value(s): ${bad.join(', ')}. Use the names on the Lists sheet.` } : { value: [...new Set(out)] };
    }
    case 'yesno': {
      const v = text.toLowerCase();
      if (['yes', 'y', 'true', '1'].includes(v)) return { value: true };
      if (['no', 'n', 'false', '0'].includes(v)) return { value: false };
      return { value: text, problem: 'Use Yes or No.' };
    }
    case 'int':
      return /^\d{1,4}$/.test(text) ? { value: Number(text) } : { value: text, problem: 'Use a whole number.' };
    case 'url':
      try {
        const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        return { value: u.toString() };
      } catch {
        return { value: text, problem: 'Not a valid web address.' };
      }
    case 'timezone':
      return isValidTimeZone(text) ? { value: text } : { value: text, problem: 'Unknown time zone (use e.g. Asia/Qatar).' };
  }
}

let defaultParser: BulkTemplateParser | null = null;
let defaultParserDir = '';

/** The parser the server uses (swap point for @sonu/core). */
export function getBulkParser(assetsDir: string): BulkTemplateParser {
  if (!defaultParser || defaultParserDir !== assetsDir) {
    defaultParser = new ExcelJsBulkParser(assetsDir);
    defaultParserDir = assetsDir;
  }
  return defaultParser;
}
