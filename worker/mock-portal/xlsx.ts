/** Export files served by the mock portal: synthetic fixtures from app/fixtures if asked for, else tiny generated .xlsx files. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

function fakeValue(caption: string, row: number): string | number {
  const c = caption.toLowerCase();
  if (c.includes('date')) return `11/${row + 1}/2026`;
  if (c.includes('cost') || c.includes('amount') || c.includes('hours') || c.includes('count') || c.includes('quantity')) return row * 10 + 5;
  if (c === 'work request code') return 9_000_000 + row;
  if (c.includes('contractor')) return 'Test Contractor W.L.L.';
  if (c.includes('work team')) return `WT-TEST${row}`;
  return `Sample ${row}`;
}

export async function generateXlsx(captions: string[], rows = 3): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SONU mock portal (fictional data)';
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(captions);
  for (let r = 1; r <= rows; r++) ws.addRow(captions.map((c) => fakeValue(c, r)));
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Find a synthetic fixture for a list key in a fixtures folder (file name contains the key, - or _). */
export async function findFixture(dir: string, key: string): Promise<{ name: string; data: Buffer } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '_');
  const hit = names.find((n) => /\.(xlsx|xls)$/i.test(n) && norm(n).includes(key));
  if (!hit) return null;
  return { name: hit, data: await readFile(join(dir, hit)) };
}
