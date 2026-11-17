import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTOR_STATUSES, RfeValidationError, buildMasterRows, loadLookups, parseBulkTemplate, parseExport, parseTrackerWorkbook,
  suggestContractorStatus, summarise, writeMasterWorkbook, writeRfeWorkbook, type BulkKind, type RfeLine,
} from '../src/index.js';
import { asset, fx, lookupsJson } from './helpers.js';

async function edit(file: string, fn: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(asset(file) as unknown as ArrayBuffer);
  fn(wb);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const put = (ws: ExcelJS.Worksheet | undefined, row: number, vals: (string | number | null)[]) => vals.forEach((v, i) => (ws!.getRow(row).getCell(i + 1).value = v));

describe('bulk templates', () => {
  it('untouched contractor template: example skipped, no rows', () => {
    const r = parseBulkTemplate('contractors', asset('SONU-import-contractors.xlsx'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skippedExamples).toBe(1);
      expect(r.sheets.Contractors.rows).toEqual([]);
    }
  });
  it('contractors: good row, bad e-mail, missing compulsory, duplicate, bad status, bad mobile', async () => {
    const buf = await edit('SONU-import-contractors.xlsx', (wb) => {
      const ws = wb.getWorksheet('Contractors');
      put(ws, 3, ['TEST-A', 'Test Contractor A W.L.L.', null, 'T1', 'WT-1; WT-2', 'Civil', 'Admin A', 'Admin.A@Example.com', '+974 5555 0100', null, 'Asia/Qatar', 'Active', null]);
      put(ws, 4, ['TEST-B', 'Test Contractor B', null, null, null, null, 'Admin B', 'not-an-email', null, null, null, 'Active', null]);
      put(ws, 5, ['TEST-C', null, null, null, null, null, 'Admin C', 'c@example.com', null, null, null, 'Active', null]);
      put(ws, 6, ['test-a', 'Dup', null, null, null, null, 'Admin D', 'd@example.com', null, null, null, 'Maybe', null]);
      put(ws, 7, ['TEST-E', 'E', null, null, null, null, 'Admin E', 'e@example.com', '55550100', null, 'Mars/Base', 'Active', null]);
    });
    const r = parseBulkTemplate('contractors', buf);
    if (!r.ok) throw new Error(r.error);
    const rows = r.sheets.Contractors.rows;
    expect(r.skippedExamples).toBe(1);
    expect(rows.map((x) => x.rowNumber)).toEqual([3, 4, 5, 6, 7]);
    expect(rows[0].problems).toEqual([]);
    expect(rows[0].values['Admin Email']).toBe('admin.a@example.com');
    expect(rows[0].values['Admin Mobile']).toBe('+97455550100');
    expect(rows[1].problems.map((p) => p.column)).toEqual(['Admin Email']);
    expect(rows[2].problems).toEqual([{ column: 'Company Name', reason: 'Compulsory value is missing.' }]);
    expect(rows[3].problems.map((p) => p.column).sort()).toEqual(['Contractor Code', 'Status']);
    expect(rows[4].problems.map((p) => p.column).sort()).toEqual(['Admin Mobile', 'Time Zone']);
  });
  it.each(['Password', 'Marafiq pwd', 'API Secret', 'Passcode'])('a "%s" column refuses the whole file', async (cap) => {
    const buf = await edit('SONU-import-users.xlsx', (wb) => {
      wb.getWorksheet('Users')!.getRow(1).getCell(16).value = cap;
      put(wb.getWorksheet('Users'), 3, ['TEST-A', 'User A', 'a@example.com']);
    });
    const r = parseBulkTemplate('users', buf);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(cap);
    expect(Object.keys(r.sheets)).toEqual([]);
  });
  it('users: duplicate e-mail, bad role', async () => {
    const buf = await edit('SONU-import-users.xlsx', (wb) => {
      const ws = wb.getWorksheet('Users');
      put(ws, 3, ['TEST-A', 'User A', 'a@example.com', '+97455550111', 'Foreman', null, null, null, null, 'English', 'Yes', 'No', 'Yes', null, 'Active']);
      put(ws, 4, ['TEST-A', 'User B', 'A@example.com', null, 'Wizard', null, null, null, null, null, null, null, null, null, 'Active']);
    });
    const r = parseBulkTemplate('users', buf);
    if (!r.ok) throw new Error(r.error);
    const rows = r.sheets.Users.rows;
    expect(rows[0].problems).toEqual([]);
    expect(rows[1].problems.map((p) => p.column).sort()).toEqual(['Email', 'Role']);
  });
  it('sub-contractors: categories from the list, duplicate contact', async () => {
    const buf = await edit('SONU-import-subcontractors.xlsx', (wb) => {
      put(wb.getWorksheet('SubContractors'), 3, ['TEST-A', 'TEST-SUB-1', 'Sub One', null, null, 'Painting; Flooring', null, null, 'https://www.example.com', null, 'No', 'Verified', null]);
      put(wb.getWorksheet('SubContractors'), 4, ['TEST-A', 'TEST-SUB-2', 'Sub Two', null, null, 'Rocket science', null, null, null, null, null, 'Verified', null]);
      put(wb.getWorksheet('Contacts'), 3, ['TEST-SUB-1', 'Person One', 'Sales', '+97455550122', null, 'p1@example.com', 'Email', 'English', 'Yes', 'No', 1, 'Yes']);
      put(wb.getWorksheet('Contacts'), 4, ['TEST-SUB-1', 'Person Two', null, '+974-5555-0122']);
    });
    const r = parseBulkTemplate('subcontractors' as BulkKind, buf);
    if (!r.ok) throw new Error(r.error);
    expect(r.skippedExamples).toBe(2);
    expect(r.sheets.SubContractors.rows[0].problems).toEqual([]);
    expect(r.sheets.SubContractors.rows[1].problems.map((p) => p.column)).toEqual(['Categories']);
    expect(r.sheets.Contacts.rows[0].problems).toEqual([]);
    expect(r.sheets.Contacts.rows[1].problems.map((p) => p.column)).toEqual(['Mobile']);
  });
  it('wrong template or file', () => {
    expect(parseBulkTemplate('users', asset('SONU-import-contractors.xlsx')).ok).toBe(false);
    expect(parseBulkTemplate('users', Buffer.from('junk')).ok).toBe(false);
  });
});

describe('RFE writer', () => {
  const lines: RfeLine[] = [
    { vendorItemName: 'Test item A', uom: 'EACH', lineNumber: 10, poNumber: 'TEST-BPA-1', bpaItem: 'ITEM-A', accountCode: 'ACC-1', estQty: 2, unitPrice: 150.5, markUp: 10 },
    { vendorItemName: 'Test item B', uom: 'M', lineNumber: '20', poNumber: 'TEST-BPA-1', bpaItem: 'ITEM-B', accountCode: 'ACC-1', estQty: 3, unitPrice: 40, markUp: 10 },
    { lineType: 'Discount', vendorItemName: 'Discount', uom: 'LS', estQty: 1, unitPrice: 21, markUp: 0 },
  ];
  it('fills the import sheet, keeps the rest, names the file', async () => {
    const out = await writeRfeWorkbook(asset('marafiq-rfe-template.xlsx'), '3375060', lines);
    expect(out.fileName).toBe('rfe-3375060.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3']);
    expect(wb.getWorksheet('Sheet1')!.getCell('A1').text).toContain('Subject');
    const ws = wb.getWorksheet('Sheet2')!;
    expect(ws.getRow(3).values).toEqual(expect.arrayContaining(['Srl', 'WR No', 'Amount']));
    const v = (r: number) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((c) => ws.getRow(r).getCell(c).value);
    expect(v(4)).toEqual([1, 3375060, 'Item', 'Test item A', 'EACH', 10, 'TEST-BPA-1', 'ITEM-A', 'ACC-1', 2, 150.5, 10, 301]);
    expect(v(5)[12]).toBe(120);
    expect(v(6)[2]).toBe('Discount');
    expect(v(6)[12]).toBe(-21);
  });
  it('validates', async () => {
    await expect(writeRfeWorkbook(asset('marafiq-rfe-template.xlsx'), '12345', lines)).rejects.toBeInstanceOf(RfeValidationError);
    await expect(writeRfeWorkbook(asset('marafiq-rfe-template.xlsx'), '3375060', [lines[2], lines[0]])).rejects.toThrow(/Discount cannot be the first/);
    await expect(writeRfeWorkbook(asset('marafiq-rfe-template.xlsx'), '3375060', [{ ...lines[0], estQty: 0, accountCode: '' }])).rejects.toThrow(/Quantity|Account code/);
    await expect(writeRfeWorkbook(asset('marafiq-rfe-template.xlsx'), '3375060', [lines[0], { ...lines[2], unitPrice: 5000 }])).rejects.toThrow(/Total value/);
  });
});

describe('tracker, statuses, master workbook', () => {
  it('has the 15 statuses', () => {
    expect(CONTRACTOR_STATUSES).toHaveLength(15);
    expect(CONTRACTOR_STATUSES.filter((s) => s.side === 'contractor')).toHaveLength(7);
    expect(CONTRACTOR_STATUSES.filter((s) => s.side === 'qf')).toHaveLength(5);
  });
  it('maps old spellings, reports ambiguous and unknown', () => {
    const r = parseTrackerWorkbook(fx('tracker-master-old-spellings.xlsx'));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.status)).toEqual(['Work In Progress - TDGI', 'RFE to be submit - TDGI', null, 'Awaiting Approval - QF', null, 'Work In Progress - TDGI']);
    expect(r.unknownStatuses.map((u) => u.value).sort()).toEqual(['Awaiting Material', 'Pending for survey']);
    expect(r.unknownStatuses.find((u) => u.value === 'Awaiting Material')!.candidates).toHaveLength(2);
  });
  it('rejects a workbook without the Status sheet', () => {
    expect(parseTrackerWorkbook(fx('pending-work-requests.xlsx')).ok).toBe(false);
  });
  it('master workbook round-trips through parseTrackerWorkbook', async () => {
    loadLookups(lookupsJson());
    const p = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
    if (!p.ok) throw new Error('parse');
    const typed = new Map(p.rows.map((r, i) => [String(r.wrCode), { status: i % 2 ? 'Completed' : 'Awaiting Access - QF', fcRemarks: `Test remark ${i}` }]));
    const rows = buildMasterRows(p.rows, { today: '2026-11-09', typed });
    const buf = await writeMasterWorkbook(rows, summarise(rows, { today: '2026-11-09' }), { asOf: '2026-11-09' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Status', 'Statistics', 'Summary', 'Dashboard Data']);
    expect(wb.getWorksheet('Status')!.getRow(2).getCell(3).value).toBe('Work Request Code');
    const back = parseTrackerWorkbook(buf);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows).toHaveLength(60);
    expect(back.unknownStatuses).toEqual([]);
    expect(back.rows.map((r) => [r.wrCode, r.status, r.fcRemarks])).toEqual(rows.map((r) => [r.wrCode, r.status, r.fcRemarks ?? '']));
  });
  it('the shipped tracker fixture loads', () => {
    const r = parseTrackerWorkbook(fx('tracker-master.xlsx'));
    expect(r.ok && r.rows.length).toBe(60);
  });
});

describe('suggestContractorStatus', () => {
  it.each([
    [{ wrStatus: 'Assigned to Work Order', descriptiveStatus: '2. SP : Awaiting Site Survey & Estimation', inspectionDone: false }, 'Awaiting Information - TDGI'],
    [{ materialRequestRaised: true, quotationsComplete: false }, 'Awaiting Quote - TDGI'],
    [{ wrStatus: 'Assigned to Work Order', estimatedTotalCost: 0, inspectionDone: true }, 'RFE to be submit - TDGI'],
    [{ budgetCodeRequested: true, budgetCodeReceived: false }, 'Awaiting budget code - QF'],
    [{ descriptiveStatus: '3. QF : Awaiting Estimation Approval' }, 'Awaiting Approval - QF'],
    [{ descriptiveStatus: '4. SP : Awaiting Estimation Re-Submission' }, 'RFE to be Resubmitted - TDGI'],
    [{ rfeApproved: true, lpoDelivered: false }, 'Awaiting Material - TDGI'],
    [{ rfeApproved: true, lpoDelivered: true, workStarted: false }, 'Material received under planning - TDGI'],
    [{ rfeApproved: true, waitingForQfSupply: true }, 'Awaiting Material - QF'],
    [{ wrStatus: 'Issued and In Process' }, 'Work In Progress - TDGI'],
    [{ wrStatus: 'Contractor Completed', descriptiveStatus: '8. QF : Contractor Completed' }, 'Completed'],
  ])('%j -> %s', (facts, out) => {
    expect(suggestContractorStatus(facts)?.status).toBe(out);
    expect(suggestContractorStatus(facts)?.reason).toBeTruthy();
  });
  it('no facts, no suggestion', () => expect(suggestContractorStatus({})).toBeNull());
});
