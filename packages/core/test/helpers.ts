import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = resolve(here, '../../../fixtures');
export const ASSETS = resolve(here, '../../../assets');

export const fx = (name: string) => readFileSync(resolve(FIX, name));
export const asset = (name: string) => readFileSync(resolve(ASSETS, name));
export const fxJson = (name: string) => JSON.parse(readFileSync(resolve(FIX, name), 'utf8'));
export const lookupsJson = () => JSON.parse(readFileSync(resolve(ASSETS, 'tracker-lookups.json'), 'utf8'));

/** Build a workbook in memory from rows of cells. bookType 'biff8' makes a legacy .xls. */
export function makeBook(aoa: unknown[][], bookType: 'xlsx' | 'biff8' = 'xlsx', sheet = 'Export'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa as never), sheet);
  return XLSX.write(wb, { bookType, type: 'buffer' });
}
