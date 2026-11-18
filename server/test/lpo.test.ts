import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createContractorWithAdmin, makeTestApp, PASSWORD, setupPlatformAdmin, tokenFromOutbox, type TestContext } from './helpers.js';

const TODAY = '2026-11-09';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(64)]);

function multipart(name: string, fileName: string, data: Buffer, type = 'application/pdf') {
  const boundary = `----sonu${crypto.randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('LPO module', () => {
  let ctx: TestContext;
  let aAdmin: Client;
  let aId: string;
  const users: Record<string, { c: Client; id: string }> = {};
  const wrId: Record<string, string> = {};

  async function makeUser(admin: Client, email: string, role: string, workTeamIds: string[] = []) {
    const r = await admin.post('/api/admin/users', { email, fullName: `${role} ${email.split('@')[0]}`, role, workTeamIds });
    if (r.statusCode !== 201) throw new Error(`create user ${r.body}`);
    const token = await tokenFromOutbox(ctx.db, email);
    const c = new Client(ctx.app);
    const acc = await c.post('/api/auth/accept-invite', { token, password: PASSWORD });
    if (acc.statusCode !== 200) throw new Error(`accept ${acc.body}`);
    return { c, id: r.json().user.id as string };
  }
  const body = (wrCode: string, extra: Record<string, unknown> = {}) => ({ wrCode, lpoNo: 'LPO-TEST-1', issueDate: TODAY, vendorName: 'Test Vendor Co', approvedAmount: 1250.5, ...extra });

  beforeAll(async () => {
    ctx = await makeTestApp();
    ctx.app.opsClock.today = TODAY;
    ctx.app.opsClock.now = () => new Date(`${TODAY}T09:00:00Z`);
    const platform = await setupPlatformAdmin(ctx);
    ({ admin: aAdmin, contractorId: aId } = await createContractorWithAdmin(platform, ctx, 'LPA', 'admin.lpa@example.com'));
    await aAdmin.post('/api/admin/work-teams', { code: 'LP-WT-1' });
    await aAdmin.post('/api/admin/work-teams', { code: 'LP-WT-2' });
    const teams = (await aAdmin.get('/api/admin/work-teams')).json().items as { id: string; code: string }[];
    const id1 = teams.find((t) => t.code === 'LP-WT-1')!.id;
    const id2 = teams.find((t) => t.code === 'LP-WT-2')!.id;
    users.purchasing = await makeUser(aAdmin, 'lp.purchasing@example.com', 'purchasing');
    users.sup1 = await makeUser(aAdmin, 'lp.sup1@example.com', 'supervisor', [id1]);
    users.sup2 = await makeUser(aAdmin, 'lp.sup2@example.com', 'supervisor', [id2]);
    users.tech = await makeUser(aAdmin, 'lp.tech@example.com', 'technician', [id1]);
    const rows: [string, string, string, string | null][] = [
      ['approved', 'LP-WT-1', '9200001', '2026-10-30'],
      ['approved2', 'LP-WT-1', '9200002', '2026-11-01'],
      ['notyet', 'LP-WT-1', '9200003', null],
      ['done', 'LP-WT-1', '9200004', '2026-10-01'],
    ];
    for (const [key, team, code, approved] of rows) {
      const r = await ctx.db.query<{ id: string }>(
        `INSERT INTO work_request (contractor_id, wr_code, wr_status, work_team_code, description, building_name) VALUES ($1,$2,$3,$4,'Leaking tap','Test Building') RETURNING id`,
        [aId, code, key === 'done' ? 'Completed' : 'Assigned to Work Order', team],
      );
      wrId[key] = r.rows[0]!.id;
      await ctx.db.query(
        `INSERT INTO rfe_status (contractor_id, work_request_id, wr_code, submitted_on, approved_on, pending_with, rfe_amount) VALUES ($1,$2,$3,'2026-10-20'::date::timestamp AT TIME ZONE 'UTC',$4::date::timestamp AT TIME ZONE 'UTC','QF',1300)`,
        [aId, r.rows[0]!.id, code, approved],
      );
    }
    await ctx.db.query(
      `INSERT INTO rfe_comment (contractor_id, work_request_id, log_id, wr_code, text, created_by_name, created_on) VALUES ($1,$2,'LG1','9200001','Please confirm scope','QF Reviewer','2026-10-25'::date::timestamp AT TIME ZONE 'UTC')`,
      [aId, wrId.approved],
    );
  }, 120_000);
  afterAll(async () => ctx?.close());

  let lpoId: string;
  let docId: string;

  it('purchasing creates an LPO; it shows on the WR detail and the pending list shrinks', async () => {
    const before = (await users.purchasing!.c.get('/api/lpo/pending')).json();
    expect(before.items.map((x: { wrCode: string }) => x.wrCode)).toEqual(['9200001', '9200002']);
    expect(before.items[0]).toMatchObject({ rfeAmount: 1300, approvedOn: '2026-10-30', daysSinceApproval: 10 });
    const sum0 = (await users.purchasing!.c.get('/api/procurement/summary')).json();
    expect(sum0.lpo).toEqual({ pending: 2, releasedThisMonth: 0, released: 0 });

    const r = await users.purchasing!.c.post('/api/lpo', body('9200001'));
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j).toMatchObject({ lpoNo: 'LPO-TEST-1', status: 'released', approvedAmount: 1250.5, rfeAmountSnapshot: 1300, rfeApprovedOn: '2026-10-30', warning: null });
    expect(j.history[0].action).toBe('created');
    lpoId = j.id;

    const wr = (await users.purchasing!.c.get('/api/work-requests/9200001')).json();
    expect(wr.lpos).toHaveLength(1);
    expect(wr.lpos[0]).toMatchObject({ id: lpoId, vendorName: 'Test Vendor Co' });
    expect(wr.rfeHistory.map((h: { kind: string }) => h.kind)).toEqual(expect.arrayContaining(['rfe_submitted', 'rfe_approved', 'comment', 'lpo.released']));

    const after = (await users.purchasing!.c.get('/api/lpo/pending')).json();
    expect(after.items.map((x: { wrCode: string }) => x.wrCode)).toEqual(['9200002']);
    const sum = (await users.purchasing!.c.get('/api/procurement/summary')).json();
    expect(sum.lpo).toEqual({ pending: 1, releasedThisMonth: 1, released: 1 });
    expect(sum.pettyCash).toBeTruthy();
    const list = (await users.purchasing!.c.get('/api/lpo?q=test%20vendor')).json();
    expect(list.items).toHaveLength(1);
  });

  it('refuses a duplicate LPO number with 409', async () => {
    const r = await users.purchasing!.c.post('/api/lpo', body('9200002'));
    expect(r.statusCode).toBe(409);
  });

  it('a supervisor cannot create but can see the LPO on a WR in scope; another team cannot', async () => {
    expect((await users.sup1!.c.post('/api/lpo', body('9200002', { lpoNo: 'X-2' }))).statusCode).toBe(403);
    const wr = (await users.sup1!.c.get('/api/work-requests/9200001')).json();
    expect(wr.lpos).toHaveLength(1);
    expect((await users.sup1!.c.get(`/api/lpo/${lpoId}`)).statusCode).toBe(200);
    expect((await users.sup2!.c.get(`/api/lpo/${lpoId}`)).statusCode).toBe(404);
    expect((await users.sup2!.c.get('/api/lpo')).json().items).toHaveLength(0);
    expect((await users.sup1!.c.get('/api/lpo/pending')).json().items).toHaveLength(1);
  });

  it('a warning is returned when the RFE is not approved yet, and the LPO is still created', async () => {
    const r = await users.purchasing!.c.post('/api/lpo', body('9200003', { lpoNo: 'LPO-TEST-3' }));
    expect(r.statusCode).toBe(201);
    expect(r.json().warning).toBe('RFE not approved yet in the imported Marafiq data');
    expect(r.json().rfeAmountSnapshot).toBe(1300);
  });

  it('uploads a document; supervisor in scope can open it, technician and other team cannot', async () => {
    const { payload, contentType } = multipart('file', 'lpo.pdf', PDF);
    const up = await ctx.app.inject({ method: 'POST', url: `/api/lpo/${lpoId}/documents`, payload, headers: { 'content-type': contentType, 'x-requested-with': 'sonu', cookie: users.purchasing!.c.cookie } });
    expect(up.statusCode).toBe(201);
    docId = up.json().documents[0].id;
    const bad = multipart('file', 'x.pdf', Buffer.from('not a pdf'));
    const r2 = await ctx.app.inject({ method: 'POST', url: `/api/lpo/${lpoId}/documents`, payload: bad.payload, headers: { 'content-type': bad.contentType, 'x-requested-with': 'sonu', cookie: users.purchasing!.c.cookie } });
    expect(r2.statusCode).toBe(415);
    expect((await users.purchasing!.c.get(`/api/attachments/${docId}`)).statusCode).toBe(200);
    expect((await users.sup1!.c.get(`/api/attachments/${docId}`)).statusCode).toBe(200);
    expect((await users.sup2!.c.get(`/api/attachments/${docId}`)).statusCode).toBe(404);
    expect((await users.tech!.c.get(`/api/attachments/${docId}`)).statusCode).toBe(404);
    expect((await users.sup1!.c.del(`/api/lpo/${lpoId}/documents/${docId}`)).statusCode).toBe(403);
  });

  it('update and cancel write history; a cancelled LPO frees the number and returns the WR to pending', async () => {
    const u = await users.purchasing!.c.patch(`/api/lpo/${lpoId}`, { vendorName: 'Other Vendor', approvedAmount: 1000 });
    expect(u.statusCode).toBe(200);
    expect((await users.purchasing!.c.patch(`/api/lpo/${lpoId}`, {})).statusCode).toBe(400);
    const h = u.json().history as { action: string; changes: Record<string, { from: unknown; to: unknown }> }[];
    expect(h.map((x) => x.action)).toEqual(['created', 'document_added', 'updated']);
    expect(h[2]!.changes.vendorName).toEqual({ from: 'Test Vendor Co', to: 'Other Vendor' });
    expect(h[2]!.changes.approvedAmount).toEqual({ from: 1250.5, to: 1000 });

    expect((await users.purchasing!.c.post(`/api/lpo/${lpoId}/cancel`, {})).statusCode).toBe(400);
    const c = await users.purchasing!.c.post(`/api/lpo/${lpoId}/cancel`, { reason: 'Wrong vendor' });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: 'cancelled', cancelledReason: 'Wrong vendor' });
    expect(c.json().history.at(-1).action).toBe('cancelled');
    expect((await users.purchasing!.c.patch(`/api/lpo/${lpoId}`, { remarks: 'x' })).statusCode).toBe(409);
    const wr = (await users.purchasing!.c.get('/api/work-requests/9200001')).json();
    expect(wr.lpos).toHaveLength(1);
    expect(wr.lpos[0].status).toBe('cancelled');
    expect((await users.purchasing!.c.get('/api/lpo/pending')).json().items.map((x: { wrCode: string }) => x.wrCode)).toContain('9200001');
    expect((await users.purchasing!.c.post('/api/lpo', body('9200001'))).statusCode).toBe(201);
  });

  it('the linked MR must belong to the same WR; the MR detail lists its LPOs', async () => {
    const mr = await users.sup1!.c.post('/api/mr', { wrCode: '9200002', purchaseType: 'materials', purpose: 'new', lines: [{ description: 'Valve', quantity: 1 }] });
    expect(mr.statusCode).toBe(201);
    const mrId = mr.json().id as string;
    const bad = await users.purchasing!.c.post('/api/lpo', body('9200001', { lpoNo: 'LPO-TEST-9', materialRequestId: mrId }));
    expect(bad.statusCode).toBe(400);
    const ok = await users.purchasing!.c.post('/api/lpo', body('9200002', { lpoNo: 'LPO-TEST-9', materialRequestId: mrId }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mrCode).toBe('MR-1');
    const detail = (await users.purchasing!.c.get(`/api/mr/${mrId}`)).json();
    expect(detail.lpos).toHaveLength(1);
    expect(detail.lpos[0].lpoNo).toBe('LPO-TEST-9');
    const n = await ctx.db.query(`SELECT 1 FROM notification WHERE contractor_id = $1 AND title LIKE 'LPO LPO-TEST-9%'`, [aId]);
    expect(n.rows.length).toBeGreaterThan(0);
  });
});
