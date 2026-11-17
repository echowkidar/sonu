import ExcelJS from 'exceljs';
import { toBuffer, type BinaryInput } from './excel.js';

/**
 * Fills the import sheet of the official Marafiq RFE template (assets/marafiq-rfe-template.xlsx).
 *
 * The real template has three sheets: "Sheet1" (a sample quotation letter), "Sheet2" (the import sheet: A1 instruction,
 * A2 example, header on row 3, data from row 4) and an empty "Sheet3". The sheet is found by its header
 * (Srl, WR No, ...) so a sheet that is called "IMPORT" in another version of the template works as well.
 * Every other sheet, merged cell, column width and validation of the template is kept.
 */

export const RFE_HEADERS = [
  'Srl',
  'WR No',
  'Line Type',
  'Vendor Item Name',
  'UOM',
  'Line Number',
  'PO Number',
  'BPA Item',
  'Account Code',
  'Est Qty',
  'Unit Price',
  'Mark Up',
  'Amount',
] as const;

export type RfeLineType = 'Item' | 'Discount' | 'Margin';

export interface RfeLine {
  /** Default Item. T / S / M (the codes Marafiq stores) are accepted too. */
  lineType?: RfeLineType | 'T' | 'S' | 'M';
  vendorItemName: string;
  uom: string;
  /** BPA line number. */
  lineNumber?: string | number;
  /** BPA agreement number. */
  poNumber?: string;
  /** BPA line (item reference). */
  bpaItem?: string;
  accountCode?: string;
  estQty: number;
  unitPrice: number;
  markUp: number;
}

export interface RfeProblem {
  /** 1-based line number, or undefined for the whole file. */
  line?: number;
  field: string;
  message: string;
}

export class RfeValidationError extends Error {
  problems: RfeProblem[];
  constructor(problems: RfeProblem[]) {
    super(`RFE lines are not valid: ${problems.map((p) => (p.line ? `line ${p.line} ${p.field}: ${p.message}` : `${p.field}: ${p.message}`)).join('; ')}`);
    this.name = 'RfeValidationError';
    this.problems = problems;
  }
}

const TYPE_MAP: Record<string, RfeLineType> = { item: 'Item', t: 'Item', discount: 'Discount', s: 'Discount', margin: 'Margin', m: 'Margin' };

export function normaliseLineType(t: RfeLine['lineType']): RfeLineType | null {
  return TYPE_MAP[String(t ?? 'Item').trim().toLowerCase()] ?? null;
}

const round = (n: number, d: number) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/**
 * Amount of a line. The template's sample letter (Sheet1) shows amount = quantity x unit price (100 x 300 = 30,000;
 * 50 x 10 = 500) with the margin on its own lines, so the Mark Up column is written as given and is NOT multiplied in.
 * A Discount line carries a negative amount (Marafiq rule: "Amount should have a negative value if the type is
 * discount"), so its amount is -(quantity x unit price). Rounded to 4 decimals (the portal stores 4).
 */
export function rfeLineAmount(line: Pick<RfeLine, 'lineType' | 'estQty' | 'unitPrice'>): number {
  const gross = round(line.estQty * line.unitPrice, 4);
  return normaliseLineType(line.lineType) === 'Discount' ? -Math.abs(gross) : gross;
}

/** Rules from the portal's line form and messages (analysis 03 section 2 and 04). */
export function validateRfeLines(wrCode: string, lines: RfeLine[]): RfeProblem[] {
  const problems: RfeProblem[] = [];
  if (!/^\d{7}$/.test(String(wrCode ?? ''))) problems.push({ field: 'wrCode', message: 'Work request code must be 7 digits.' });
  if (!Array.isArray(lines) || lines.length === 0) {
    problems.push({ field: 'lines', message: 'At least one line is needed.' });
    return problems;
  }
  let discounts = 0;
  let total = 0;
  let items = 0;
  lines.forEach((l, i) => {
    const n = i + 1;
    const t = normaliseLineType(l.lineType);
    if (!t) problems.push({ line: n, field: 'lineType', message: 'Please select a valid type (Item, Discount or Margin).' });
    if (!String(l.vendorItemName ?? '').trim()) problems.push({ line: n, field: 'vendorItemName', message: 'Item name is compulsory.' });
    if (!String(l.uom ?? '').trim()) problems.push({ line: n, field: 'uom', message: 'Unit of measure is compulsory.' });
    if (!Number.isFinite(l.estQty) || !(l.estQty > 0)) problems.push({ line: n, field: 'estQty', message: 'Quantity must be a number above 0.' });
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) problems.push({ line: n, field: 'unitPrice', message: 'Rate must be a number of 0 or more.' });
    if (!Number.isFinite(l.markUp) || l.markUp < 0) problems.push({ line: n, field: 'markUp', message: 'Mark up must be a number of 0 or more.' });
    if (t === 'Item' || t === null) {
      items++;
      for (const [f, label] of [
        ['lineNumber', 'BPA line number'],
        ['poNumber', 'Agreement (PO) number'],
        ['bpaItem', 'BPA line'],
        ['accountCode', 'Account code'],
      ] as const) {
        if (String(l[f] ?? '').trim() === '') problems.push({ line: n, field: f, message: `${label} is compulsory for an item line.` });
      }
    }
    if (t === 'Discount') {
      discounts++;
      if (i === 0) problems.push({ line: n, field: 'lineType', message: 'Discount cannot be the first value!' });
      if (discounts > 1) problems.push({ line: n, field: 'lineType', message: 'Discount value is already present, cannot add more.' });
    }
    if (t === 'Margin' && items === 0) problems.push({ line: n, field: 'lineType', message: 'Please enter Item lines for entering Margin amount!' });
    if (Number.isFinite(l.estQty) && Number.isFinite(l.unitPrice)) total += rfeLineAmount(l);
  });
  if (!(round(total, 4) > 0)) problems.push({ field: 'lines', message: 'Total value is lesser than 0, please enter discount value lesser than total amount.' });
  return problems;
}

function numericIfDigits(v: string | number | undefined): string | number | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  return /^[1-9]\d{0,14}$/.test(s) ? Number(s) : s;
}

/**
 * Write the 13 columns into the import sheet of the template.
 * WR No is written as a number when it has no leading zero (like the template's own sample), otherwise as text.
 * Line Type is written as the label (Item / Discount / Margin); `lineTypeStyle: 'code'` writes T / S / M instead
 * (which of the two the server's Excel import expects is not verified).
 * @throws RfeValidationError with every problem found (nothing is written).
 */
export async function writeRfeWorkbook(
  templateBuffer: BinaryInput,
  wrCode: string,
  lines: RfeLine[],
  opts: { lineTypeStyle?: 'label' | 'code' } = {},
): Promise<{ fileName: string; buffer: Buffer }> {
  const problems = validateRfeLines(wrCode, lines);
  if (problems.length) throw new RfeValidationError(problems);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(toBuffer(templateBuffer) as unknown as ArrayBuffer);

  // Find the import sheet: by name IMPORT, else by header Srl / WR No within the first 10 rows.
  let ws: ExcelJS.Worksheet | undefined = wb.worksheets.find((s) => s.name.toLowerCase() === 'import');
  let headerRow = 3;
  const findHeader = (s: ExcelJS.Worksheet): number | null => {
    for (let r = 1; r <= Math.min(10, s.rowCount); r++) {
      const a = String(s.getRow(r).getCell(1).text ?? '').trim().toLowerCase();
      const b = String(s.getRow(r).getCell(2).text ?? '').trim().toLowerCase();
      const c = String(s.getRow(r).getCell(3).text ?? '').trim().toLowerCase();
      if (a === 'srl' && b === 'wr no' && c === 'line type') return r;
    }
    return null;
  };
  if (ws) headerRow = findHeader(ws) ?? headerRow;
  else {
    for (const s of wb.worksheets) {
      const h = findHeader(s);
      if (h) {
        ws = s;
        headerRow = h;
        break;
      }
    }
  }
  if (!ws) throw new Error('The template has no import sheet (header Srl / WR No ...). Is this the official Marafiq RFE template?');

  const first = headerRow + 1;
  const styleRow = ws.getRow(first);
  lines.forEach((l, i) => {
    const t = normaliseLineType(l.lineType)!;
    const row = ws!.getRow(first + i);
    const typeCell = opts.lineTypeStyle === 'code' ? { Item: 'T', Discount: 'S', Margin: 'M' }[t] : t;
    const values: (string | number | null)[] = [
      i + 1,
      /^[1-9]/.test(wrCode) ? Number(wrCode) : wrCode,
      typeCell,
      l.vendorItemName.trim(),
      l.uom.trim(),
      numericIfDigits(l.lineNumber),
      l.poNumber?.trim() || null,
      l.bpaItem?.trim() || null,
      l.accountCode?.trim() || null,
      l.estQty,
      l.unitPrice,
      l.markUp,
      rfeLineAmount(l),
    ];
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      if (i > 0 && styleRow.getCell(c + 1).style) cell.style = { ...styleRow.getCell(c + 1).style };
    });
    row.commit();
  });

  const out = await wb.xlsx.writeBuffer();
  return { fileName: `rfe-${wrCode}.xlsx`, buffer: Buffer.from(out as ArrayBuffer) };
}
