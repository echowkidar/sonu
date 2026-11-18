import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { Client, createContractorWithAdmin, makeTestApp, PASSWORD, setupPlatformAdmin, tokenFromOutbox, type TestContext } from './helpers.js';

const TODAY = '2026-11-09';

type Part = { name: string; value: string } | { name: string; fileName: string; data: Buffer; type?: string };
function multipart(parts: Part[]) {
  const boundary = `----sonu${crypto.randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('data' in p) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.fileName}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`));
      chunks.push(p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);

describe('petty cash reimbursement claims', () => {
  let ctx: TestContext;
  let aId: string;
  let aAdmin: Client;
  const users: Record<string, { c: Client; id: string }> = {};
  let wrCode: string;

  async function makeUser(admin: Client, email: string, role: string, workTeamIds: string[] = []) {
    const r = await admin.post('/api/admin/users', { email, fullName: `${role} ${email.split('@')[0]}`, role, workTeamIds });
    if (r.statusCode !== 201) throw new Error(`create user ${r.body}`);
    const token = await tokenFromOutbox(ctx.db, email);
    const c = new Client(ctx.app);
    const acc = await c.post('/api/auth/accept-invite', { token, password: PASSWORD });
    if (acc.statusCode !== 200) throw new Error(`accept ${acc.body}`);
    return { c, id: r.json().user.id as string };
  }
  async function upload(c: Client, url: string, parts: Part[]) {
    const { payload, contentType } = multipart(parts);
    return ctx.app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, 'x-requested-with': 'sonu', cookie: c.cookie } });
  }
  const action = (c: Client, id: string, body: Record<string, unknown>) => c.post(`/api/petty-cash/${id}/action`, body);
  const told = async (userId: string, event: string) =>
    (await ctx.db.query<{ title: string; link: string }>(`SELECT title, link FROM notification WHERE recipient_id = $1 AND event = $2 AND channel = 'in_app'`, [userId, event])).rows;

  beforeAll(async () => {
    ctx = await makeTestApp();
    ctx.app.opsClock.today = TODAY;
    ctx.app.opsClock.now = () => new Date(`${TODAY}T09:00:00Z`);
    const platform = await setupPlatformAdmin(ctx);
    ({ admin: aAdmin, contractorId: aId } = await createContractorWithAdmin(platform, ctx, 'PCA', 'admin.pca@example.com'));
    await aAdmin.post('/api/admin/work-teams', { code: 'PC-WT-1' });
    await aAdmin.post('/api/admin/work-teams', { code: 'PC-WT-2' });
    const teams = (await aAdmin.get('/api/admin/work-teams')).json().items as { id: string; code: string }[];
    const id1 = teams.find((t) => t.code === 'PC-WT-1')!.id;
    const id2 = teams.find((t) => t.code === 'PC-WT-2')!.id;
    users.sup = await makeUser(aAdmin, 'pc.sup@example.com', 'supervisor', [id1]);
    users.sup2 = await makeUser(aAdmin, 'pc.sup2@example.com', 'supervisor', [id2]);
    users.manager = await makeUser(aAdmin, 'pc.manager@example.com', 'manager');
    users.purchasing = await makeUser(aAdmin, 'pc.purchasing@example.com', 'purchasing');
    users.foreman = await makeUser(aAdmin, 'pc.foreman@example.com', 'foreman', [id1]);
    wrCode = '9200001';
    await ctx.db.query(
      `INSERT INTO work_request (contractor_id, wr_code, wr_status, work_team_code, description, building_name) VALUES ($1,$2,'Assigned to Work Order','PC-WT-1','Leaking tap','Test Building')`,
      [aId, wrCode],
    );
    // 0 RFE with two purchases (one with a receipt), made by the supervisor
    expect((await users.sup!.c.patch(`/api/work-requests/${wrCode}`, { takeOwnership: true })).statusCode).toBe(200);
    expect((await users.sup!.c.post(`/api/work-requests/${wrCode}/zero-rfe`, { amount: 40 })).statusCode).toBe(200);
    const p1 = await upload(users.sup!.c, `/api/work-requests/${wrCode}/purchases`, [
      { name: 'item', value: 'Mixer tap' }, { name: 'amount', value: '30.25' }, { name: 'purchasedOn', value: TODAY }, { name: 'pettyCashRef', value: 'BILL-77' },
      { name: 'photo', fileName: 'receipt.png', data: PNG, type: 'image/png' },
    ]);
    expect(p1.statusCode).toBe(201);
    const p2 = await upload(users.sup!.c, `/api/work-requests/${wrCode}/purchases`, [{ name: 'item', value: 'Seal kit' }, { name: 'amount', value: '12' }, { name: 'purchasedOn', value: '2026-10-30' }]);
    expect(p2.statusCode).toBe(201);
  }, 120_000);
  afterAll(async () => ctx?.close());

  let claim: string;

  it('supervisor creates a draft, imports local purchases once, adds a manual line; totals are right', async () => {
    const c = await users.sup!.c.post('/api/petty-cash', { projectName: 'TD-TEST Project', month: '2026-11' });
    expect(c.statusCode).toBe(201);
    claim = c.json().id as string;
    expect(c.json()).toMatchObject({ code: 'PC-1', status: 'draft', month: '2026-11', projectName: 'TD-TEST Project', purchaseType: 'materials', totalAmount: 0, preparedByName: expect.stringContaining('supervisor') });
    expect(c.json().unclaimedCount).toBe(2);

    const imp = await users.sup!.c.post(`/api/petty-cash/${claim}/import-local-purchases`, {});
    expect(imp.statusCode).toBe(200);
    expect(imp.json().added).toBe(2);
    const d = imp.json().claim;
    expect(d.totalAmount).toBe(42.25);
    expect(d.lines).toHaveLength(2);
    const tap = d.lines.find((l: { materialUsed: string }) => l.materialUsed === 'Mixer tap');
    expect(tap).toMatchObject({ wrCode, wrStatus: 'Assigned to Work Order', workDescription: 'Leaking tap', location: 'Test Building', billDate: TODAY, billNo: 'BILL-77', qty: 1, unitCost: 30.25, totalAmount: 30.25, rfeApprovedAmount: 0, claimable: true });
    expect(tap.localPurchaseId).toBeTruthy();
    expect(tap.receipts).toHaveLength(1);
    expect(tap.receipts[0]).toMatchObject({ source: 'local_purchase' });
    // the receipt file can be opened through the claim by the preparer and by purchasing, not by a supervisor of another zone
    const fileId = tap.receipts[0].id as string;
    expect((await users.sup!.c.get(`/api/attachments/${fileId}`)).statusCode).toBe(200);
    expect((await users.purchasing!.c.get(`/api/attachments/${fileId}`)).statusCode).toBe(200);
    expect((await users.sup2!.c.get(`/api/attachments/${fileId}`)).statusCode).toBe(404);

    // not importable twice
    const again = await users.sup!.c.post(`/api/petty-cash/${claim}/import-local-purchases`, {});
    expect(again.json().added).toBe(0);
    const second = await users.sup!.c.post('/api/petty-cash', {});
    expect(second.json().code).toBe('PC-2');
    expect(second.json().projectName).toBe('TD-TEST Project');
    expect(second.json().unclaimedCount).toBe(0);
    // and the WR card / 0 RFE report show the claim
    const det = (await users.sup!.c.get(`/api/work-requests/${wrCode}`)).json();
    expect(det.localPurchases.map((p: { claim: { code: string; status: string } | null }) => p.claim?.code)).toEqual(['PC-1', 'PC-1']);
    // a purchase on a claim cannot be deleted
    expect((await users.sup!.c.del(`/api/work-requests/${wrCode}/purchases/${det.localPurchases[0].id}`)).statusCode).toBe(409);
    const rep = (await users.sup!.c.get('/api/zero-rfe?month=2026-11')).json();
    expect(rep.items[0]).toMatchObject({ wrCode, purchases: 2, claimed: 2, claims: [{ code: 'PC-1', status: 'draft' }] });

    // manual line with a WR code (fills WR data), a discount and a bill photo
    const bad = await users.sup!.c.post(`/api/petty-cash/${claim}/lines`, { wrCode: '0000000', qty: 1, unitCost: 5 });
    expect(bad.statusCode).toBe(400);
    expect((await users.sup!.c.post(`/api/petty-cash/${claim}/lines`, { qty: 0, unitCost: 5 })).statusCode).toBe(400);
    expect((await users.sup!.c.post(`/api/petty-cash/${claim}/lines`, { qty: 1, unitCost: 5, discount: 9 })).statusCode).toBe(400);
    const add = await users.sup!.c.post(`/api/petty-cash/${claim}/lines`, {
      wrCode, supplier: 'Test Supplier', materialUsed: 'Hose 2m', billDate: '2026-11-03', billNo: 'B-9', qty: 3, unit: 'pcs', unitCost: 10.1, discount: 0.5, glCode: 'GL-1', wbs: 'WBS-1', grnCode: 'GRN-1',
    });
    expect(add.statusCode).toBe(201);
    const manual = add.json().lines.find((l: { billNo: string }) => l.billNo === 'B-9');
    expect(manual).toMatchObject({ totalAmount: 29.8, wrStatus: 'Assigned to Work Order', workDescription: 'Leaking tap', rfeApprovedAmount: 0 });
    expect(add.json().totalAmount).toBe(72.05);
    const photo = await upload(users.sup!.c, `/api/petty-cash/${claim}/lines/${manual.id}/attachments`, [{ name: 'file', fileName: 'b.png', data: PNG, type: 'image/png' }]);
    expect(photo.statusCode).toBe(201);
    expect((await upload(users.sup!.c, `/api/petty-cash/${claim}/lines/${manual.id}/attachments`, [{ name: 'file', fileName: 'x.png', data: Buffer.from('nope'), type: 'image/png' }])).statusCode).toBe(415);
    const patched = await users.sup!.c.patch(`/api/petty-cash/${claim}/lines/${manual.id}`, { qty: 2 });
    expect(patched.json().lines.find((l: { id: string }) => l.id === manual.id)).toMatchObject({ totalAmount: 19.7, receipts: [expect.objectContaining({ source: 'line' })] });
    expect(patched.json().totalAmount).toBe(61.95);
    const own = (await users.sup!.c.get('/api/petty-cash?mine=1')).json().items as { code: string }[];
    expect(own.map((i) => i.code)).toEqual(['PC-2', 'PC-1']);
    // access: other supervisor, foreman
    expect((await users.sup2!.c.get(`/api/petty-cash/${claim}`)).statusCode).toBe(404);
    expect((await users.sup2!.c.get('/api/petty-cash')).json().items).toHaveLength(0);
  });

  it('submit notifies the admin; the supervisor cannot review; admin returns, supervisor edits and resubmits; admin reviews', async () => {
    expect((await action(users.sup!.c, (await users.sup!.c.post('/api/petty-cash', {})).json().id, { action: 'submit' })).statusCode).toBe(400); // no lines
    const sub = await action(users.sup!.c, claim, { action: 'submit' });
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toMatchObject({ status: 'submitted', pending: { role: 'contractor_admin' } });
    const adminId = (await ctx.db.query<{ id: string }>(`SELECT id FROM app_user WHERE contractor_id = $1 AND role = 'contractor_admin'`, [aId])).rows[0]!.id;
    expect((await told(adminId, 'petty_cash.submitted'))[0]).toMatchObject({ link: `/petty-cash/${claim}` });
    // editing is closed while submitted
    expect((await users.sup!.c.post(`/api/petty-cash/${claim}/lines`, { qty: 1, unitCost: 1 })).statusCode).toBe(409);
    expect((await users.sup!.c.patch(`/api/petty-cash/${claim}`, { projectName: 'X' })).statusCode).toBe(409);
    // roles
    expect((await action(users.sup!.c, claim, { action: 'review' })).statusCode).toBe(403);
    expect((await action(users.manager!.c, claim, { action: 'review' })).statusCode).toBe(403);
    expect((await action(users.manager!.c, claim, { action: 'approve' })).statusCode).toBe(409);
    expect((await action(users.purchasing!.c, claim, { action: 'review' })).statusCode).toBe(403);
    expect((await action(aAdmin, claim, { action: 'approve' })).statusCode).toBe(403);
    // return needs a note
    expect((await action(aAdmin, claim, { action: 'return' })).statusCode).toBe(400);
    const ret = await action(aAdmin, claim, { action: 'return', note: 'Add the GL code to line 1' });
    expect(ret.statusCode).toBe(200);
    expect(ret.json()).toMatchObject({ status: 'returned' });
    expect((await told(users.sup!.id, 'petty_cash.returned'))[0]!.title).toContain('PC-1');
    // the supervisor edits and resubmits
    const first = ret.json().lines[0].id as string;
    expect((await users.sup!.c.patch(`/api/petty-cash/${claim}/lines/${first}`, { glCode: 'GL-77' })).statusCode).toBe(200);
    expect((await action(users.sup!.c, claim, { action: 'submit' })).json().status).toBe('submitted');
    expect((await told(adminId, 'petty_cash.submitted')).length).toBe(2);
    const rev = await action(aAdmin, claim, { action: 'review' });
    expect(rev.statusCode).toBe(200);
    expect(rev.json()).toMatchObject({ status: 'reviewed', reviewedByName: expect.any(String), pending: { role: 'manager' } });
    expect((await told(users.manager!.id, 'petty_cash.reviewed')).length).toBe(1);
    expect((await action(aAdmin, claim, { action: 'review' })).statusCode).toBe(409);
    const hist = rev.json().history.map((h: { toStatus: string }) => h.toStatus);
    expect(hist).toEqual(['draft', 'submitted', 'returned', 'submitted', 'reviewed']);
  });

  it('manager approves with an adjusted amount; summary and export', async () => {
    const tooHigh = await action(users.manager!.c, claim, { action: 'approve', approvedAmounts: { [crypto.randomUUID()]: 1 } });
    expect(tooHigh.statusCode).toBe(400);
    const d = (await users.manager!.c.get(`/api/petty-cash/${claim}`)).json();
    const l1 = d.lines[0] as { id: string; totalAmount: number };
    expect((await action(users.manager!.c, claim, { action: 'approve', approvedAmounts: { [l1.id]: l1.totalAmount + 1 } })).statusCode).toBe(400);
    const ok = await action(users.manager!.c, claim, { action: 'approve', approvedAmounts: { [l1.id]: 5 } });
    expect(ok.statusCode).toBe(200);
    const j = ok.json();
    expect(j).toMatchObject({ status: 'approved', totalAmount: 61.95, approvedByName: expect.stringContaining('manager'), pending: { role: null } });
    expect(j.approvedAmount).toBe(Math.round((61.95 - l1.totalAmount + 5) * 100) / 100);
    expect(j.lines.find((l: { id: string }) => l.id === l1.id).approvedTotal).toBe(5);
    expect((await told(users.sup!.id, 'petty_cash.approved')).length).toBe(1);

    const sum = (await users.manager!.c.get('/api/procurement/summary')).json().pettyCash;
    expect(sum).toEqual({ draft: 2, pendingReview: 0, pendingApproval: 0, approved: 1, rejected: 0, approvedAmountThisMonth: j.approvedAmount });
    expect((await users.foreman!.c.get('/api/procurement/summary')).json().pettyCash).toBeNull();

    const ex = await users.purchasing!.c.get(`/api/petty-cash/${claim}/export`);
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(ex.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const texts: string[] = [];
    ws.eachRow((r) => r.eachCell((c) => texts.push(String(c.value ?? ''))));
    expect(texts).toContain('EXPENSE PETTY CASH REIMBURSEMENT CLAIM');
    expect(texts).toContain('TD-TEST Project');
    expect(texts).toContain('Total Amount Claim in Qatari Riyal');
    expect(texts).toContain('Prepared By');
    expect(ws.getRow(8).getCell(7).value).toBe('Work Description');
  });

  it('a rejected claim releases its local purchases', async () => {
    const c = (await users.sup!.c.post('/api/petty-cash', { month: '2026-11' })).json().id as string;
    // purchases are still held by the approved PC-1, so a new claim has nothing to import
    expect((await users.sup!.c.post(`/api/petty-cash/${c}/import-local-purchases`, {})).json().added).toBe(0);
    // a fresh purchase, then claim, submit, review, reject
    const p = await upload(users.sup!.c, `/api/work-requests/${wrCode}/purchases`, [{ name: 'item', value: 'Washers' }, { name: 'amount', value: '8' }, { name: 'purchasedOn', value: TODAY }]);
    expect(p.statusCode).toBe(201);
    expect((await users.sup!.c.post(`/api/petty-cash/${c}/import-local-purchases`, {})).json().added).toBe(1);
    expect((await action(users.sup!.c, c, { action: 'submit' })).statusCode).toBe(200);
    expect((await action(aAdmin, c, { action: 'review' })).statusCode).toBe(200);
    expect((await action(users.manager!.c, c, { action: 'reject' })).statusCode).toBe(400);
    const rej = await action(users.manager!.c, c, { action: 'reject', note: 'Not a valid bill' });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe('rejected');
    expect((await told(users.sup!.id, 'petty_cash.rejected')).length).toBe(1);
    // released: the purchase can go on a new claim
    const c3 = (await users.manager!.c.post('/api/petty-cash', { month: '2026-11' })).json().id as string;
    const imp = await users.manager!.c.post(`/api/petty-cash/${c3}/import-local-purchases`, {});
    expect(imp.json().added).toBe(1);
    expect(imp.json().claim.lines[0].materialUsed).toBe('Washers');
    // deleting a line frees it as well and renumbers
    const lineId = imp.json().claim.lines[0].id as string;
    const del = await users.manager!.c.del(`/api/petty-cash/${c3}/lines/${lineId}`);
    expect(del.statusCode).toBe(200);
    expect(del.json().totalAmount).toBe(0);
    expect((await users.manager!.c.post(`/api/petty-cash/${c3}/import-local-purchases`, {})).json().added).toBe(1);
    // rejected claims keep their lines but are read-only
    expect((await users.sup!.c.post(`/api/petty-cash/${c}/lines`, { qty: 1, unitCost: 1 })).statusCode).toBe(409);
    const list = (await users.purchasing!.c.get('/api/petty-cash?status=rejected,approved')).json().items as { status: string }[];
    expect(list.map((i) => i.status).sort()).toEqual(['approved', 'rejected']);
    expect((await users.purchasing!.c.get('/api/petty-cash?month=2026-10')).json().items).toHaveLength(0);
    expect((await users.purchasing!.c.post('/api/petty-cash', {})).statusCode).toBe(403);
  });

  it('foreman has no access and other contractors see nothing', async () => {
    expect((await users.foreman!.c.get('/api/petty-cash')).statusCode).toBe(403);
    expect((await users.foreman!.c.get(`/api/petty-cash/${claim}`)).statusCode).toBe(403);
    expect((await users.foreman!.c.post('/api/petty-cash', {})).statusCode).toBe(403);
    expect((await users.foreman!.c.get(`/api/petty-cash/${claim}/export`)).statusCode).toBe(403);
    expect((await users.sup!.c.get('/api/petty-cash?status=bogus')).statusCode).toBe(400);
  });
});
