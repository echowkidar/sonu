import * as XLSX from 'xlsx';

export type BinaryInput = Uint8Array | ArrayBuffer | Buffer;

export interface ReadSheetOptions {
  /** Sheet to read. Default: the sheet whose header row matches the most known captions (first sheet wins ties). */
  sheet?: string;
  /** Captions used to recognise the header row. Default: every caption of every export in this library. */
  knownCaptions?: string[];
  /** 1-based header row to use instead of searching (e.g. the tracker's row 2). */
  headerRow?: number;
  /** How many top rows to scan for the header (default 30). */
  maxScanRows?: number;
  /** A row is the header only when at least this many cells match a known caption (default 3). */
  minMatches?: number;
}

export interface SheetData {
  sheetName: string;
  /** 1-based row number of the header row, or -1 when no header row was recognised. */
  headerRow: number;
  /** Header captions in column order, whitespace normalised (trim + collapse), original case kept. */
  captions: string[];
  /** One object per data row, keyed by caption. A caption that occurs twice gets `#2`, `#3` ... on the later ones. */
  rows: Record<string, unknown>[];
  /** 1-based sheet row number of each entry in `rows` (same order). */
  rowNumbers: number[];
}

/** Trim and collapse white space. Case is NOT changed here. */
export function normaliseCaption(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key for comparing captions: whitespace normalised, case-insensitive. A renamed caption does not match. */
export function captionKey(s: unknown): string {
  return normaliseCaption(s).toLowerCase();
}

export function toBuffer(input: BinaryInput): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function readWorkbook(input: BinaryInput): XLSX.WorkBook {
  // Data only: no formulas evaluated, no macros read, no HTML rendering of cells.
  return XLSX.read(toBuffer(input), {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    cellDates: false,
    dense: false,
  });
}

/** All rows of a sheet as arrays (blank = null), keeping raw numbers (dates stay Excel serials). */
export function sheetMatrix(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true }) as unknown[][];
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

let defaultKnown: string[] | null = null;
export function setDefaultKnownCaptions(c: string[]): void {
  defaultKnown = c;
}

/**
 * Read the first useful sheet of an .xlsx or legacy .xls file.
 * The header row is found by matching known captions, so title rows above it are fine.
 * Throws only when the bytes are not a readable workbook; when no header row is recognised it returns
 * `headerRow: -1` with no rows.
 */
export function readSheet(buffer: BinaryInput, opts: ReadSheetOptions = {}): SheetData {
  const wb = readWorkbook(buffer);
  const known = new Set((opts.knownCaptions ?? defaultKnown ?? []).map(captionKey));
  const names = opts.sheet
    ? wb.SheetNames.filter((n) => n.toLowerCase() === opts.sheet!.toLowerCase())
    : wb.SheetNames;
  const maxScan = opts.maxScanRows ?? 30;
  const minMatches = opts.minMatches ?? 3;

  let best: { name: string; matrix: unknown[][]; idx: number; score: number } | null = null;
  for (const name of names) {
    const matrix = sheetMatrix(wb.Sheets[name]);
    if (opts.headerRow) {
      const idx = opts.headerRow - 1;
      if (idx < matrix.length) {
        const score = matrix[idx].filter((c) => !isBlank(c)).length;
        if (!best || score > best.score) best = { name, matrix, idx, score };
      }
      continue;
    }
    for (let i = 0; i < Math.min(matrix.length, maxScan); i++) {
      const score = matrix[i].filter((c) => !isBlank(c) && known.has(captionKey(c))).length;
      if (score >= minMatches && (!best || score > best.score)) best = { name, matrix, idx: i, score };
    }
  }
  if (!best) return { sheetName: names[0] ?? '', headerRow: -1, captions: [], rows: [], rowNumbers: [] };

  const headerCells = best.matrix[best.idx];
  const captions: string[] = [];
  const colKeys: (string | null)[] = [];
  const seen = new Map<string, number>();
  for (const c of headerCells) {
    if (isBlank(c)) {
      colKeys.push(null);
      continue;
    }
    const cap = normaliseCaption(c);
    captions.push(cap);
    const n = (seen.get(cap.toLowerCase()) ?? 0) + 1;
    seen.set(cap.toLowerCase(), n);
    colKeys.push(n === 1 ? cap : `${cap}#${n}`);
  }
  const rows: Record<string, unknown>[] = [];
  const rowNumbers: number[] = [];
  for (let r = best.idx + 1; r < best.matrix.length; r++) {
    const line = best.matrix[r];
    if (line.every(isBlank)) continue;
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < colKeys.length; c++) {
      const k = colKeys[c];
      if (k === null) continue;
      const v = line[c];
      obj[k] = typeof v === 'string' ? v.trim() : (v ?? null);
    }
    rows.push(obj);
    rowNumbers.push(r + 1);
  }
  return { sheetName: best.name, headerRow: best.idx + 1, captions, rows, rowNumbers };
}
