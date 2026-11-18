import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(64)]);

describe('material requests and the procurement summary', () => {
  let ctx: TestContext;
  let aAdmin: Client;
  let bAdmin: Client;
  let aId: string;
  const users: Record<string, { c: Client; id: string }> = {};
  const wr: Record<string, string> = {};

  async function makeUser(admin: Client, email: string, role: string, workTeamIds: string[] = []) {
    const r = await admin.post('/api/admin/users', { email, fullName: `${role} ${email.split('@')[0]}`, role, workTeamIds });
    if (r.statusCode !== 201) throw new Error(`create user ${r.body}`);
    const token = await tokenFromOutbox(ctx.db, email);
    const c = new Client(ctx.app);
    const acc = await c.post('/api/auth/accept-invite', { token, password: PASSWORD });
    if (acc.statusCode !== 200) throw new Error(`accept ${acc.body}`);
    return { c, id: r.json().user.id as string };
  }

  async function upload(c: Client, mrId: string, parts: Part[]) {
    const { payload, contentType } = multipart(parts);
    return ctx.app.inject({ method: 'POST', url: `/api/mr/${mrId}/attachments`, payload, headers: { 'content-type': contentType, 'x-requested-with': 'sonu', cookie: c.cookie } });
  }

  const line = (description: string, extra: Record<string, unknown> = {}) => ({ description, quantity: 2, uom: 'pcs', ...extra });
  const mrBody = (wrCode: string | null, extra: Record<string, unknown> = {}) => ({
    ...(wrCode ? { wrCode } : {}), purchaseType: 'materials', purpose: 'new', projectName: 'Test Project', contractNo: 'C-TEST-1', docsRequired: ['quote'],
    lines: [line('Ball valve 1 inch'), line('PTFE tape', { quantity: 10, uom: 'rolls' })], ...extra,
  });

  beforeAll(async () => {
    ctx = await makeTestApp();
    ctx.app.opsClock.today = TODAY;
    ctx.app.opsClock.now = () => new Date(`${TODAY}T09:00:00Z`);
    const platform = await setupPlatformAdmin(ctx);
    ({ admin: aAdmin, contractorId: aId } = await createContractorWithAdmin(platform, ctx, 'MRA', 'admin.mra@example.com'));
    ({ admin: bAdmin } = await createContractorWithAdmin(platform, ctx, 'MRB', 'admin.mrb@example.com'));
    await aAdmin.post('/api/admin/work-teams', { code: 'MR-WT-1' });
    await aAdmin.post('/api/admin/work-teams', { code: 'MR-WT-2' });
    const teams = (await aAdmin.get('/api/admin/work-teams')).json().items as { id: string; code: string }[];
    const id1 = teams.find((t) => t.code === 'MR-WT-1')!.id;
    const id2 = teams.find((t) => t.code === 'MR-WT-2')!.id;
    users.coord = await makeUser(aAdmin, 'mr.coord@example.com', 'coordinator');
    users.purchasing = await makeUser(aAdmin, 'mr.purchasing@example.com', 'purchasing');
    users.sup1 = await makeUser(aAdmin, 'mr.sup1@example.com', 'supervisor', [id1]);
    users.sup2 = await makeUser(aAdmin, 'mr.sup2@example.com', 'supervisor', [id2]);
    users.foreman = await makeUser(aAdmin, 'mr.foreman@example.com', 'foreman', [id1]);
    users.tech = await makeUser(aAdmin, 'mr.tech@example.com', 'technician', [id1]);
    for (const [key, team, code] of [['own', 'MR-WT-1', '9100001'], ['other', 'MR-WT-2', '9100002']] as const) {
      await ctx.db.query(
        `INSERT INTO work_request (contractor_id, wr_code, wr_status, work_team_code, description, building_name) VALUES ($1,$2,'Assigned to Work Order',$3,'Leaking tap','Test Building')`,
        [aId, code, team],
      );
      wr[key] = code;
    }
  }, 120_000);
  afterAll(async () => ctx?.close());

  let mr1: string;
  let mr1Line: string;

  it('a foreman raises an MR on his team WR, and not on another team WR', async () => {
    const ok = await users.foreman!.c.post('/api/mr', mrBody(wr.own!));
    expect(ok.statusCode).toBe(201);
    const j = ok.json();
    expect(j).toMatchObject({ mrNo: 1, mrCode: 'MR-1', status: 'submitted', wrCode: wr.own, dateRequested: TODAY, buildingName: 'Test Building', purchaseType: 'materials' });
    expect(j.lines).toHaveLength(2);
    expect(j.lines[0]).toMatchObject({ lineNo: 1, wrCode: wr.own, kind: 'material', description: 'Ball valve 1 inch' });
    expect(j.history).toHaveLength(1);
    expect(j.can).toMatchObject({ edit: true, cancel: true, procure: false });
    mr1 = j.id;
    mr1Line = j.lines[0].id;

    expect((await users.foreman!.c.post('/api/mr', mrBody(wr.other!))).statusCode).toBe(404);
    expect((await users.foreman!.c.post('/api/mr', mrBody(null))).statusCode).toBe(400);
    expect((await users.foreman!.c.post('/api/mr', mrBody(wr.own!, { lines: [] }))).statusCode).toBe(400);
    expect((await users.foreman!.c.post('/api/mr', mrBody(wr.own!, { lines: [line('x', { quantity: 0 })] }))).statusCode).toBe(400);
    expect((await users.purchasing!.c.post('/api/mr', mrBody(wr.own!))).statusCode).toBe(403);
    expect((await users.tech!.c.post('/api/mr', mrBody(wr.own!))).statusCode).toBe(403);
    expect(await ctx.db.query('SELECT 1 FROM wr_event WHERE work_request_id = (SELECT id FROM work_request WHERE wr_code = $1 AND contractor_id = $2) AND type = $3', [wr.own, aId, 'mr.submitted']).then((r) => r.rows.length)).toBe(1);
  });

  it('purchasing is notified on submit', async () => {
    const r = await ctx.db.query<{ title: string; link: string }>(
      `SELECT title, link FROM notification WHERE recipient_id = $1 AND event = 'mr.submitted' AND channel = 'in_app'`,
      [users.purchasing!.id],
    );
    expect(r.rows).toEqual([{ title: `New MR-1 for WR ${wr.own}`, link: `/procurement/mr/${mr1}` }]);
    const other = await ctx.db.query(`SELECT 1 FROM notification WHERE recipient_id = $1 AND event = 'mr.submitted'`, [users.sup1!.id]);
    expect(other.rows).toHaveLength(0);
  });

  it('visibility: requester and his zone see it, another zone, technicians and other companies do not', async () => {
    expect((await users.foreman!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(200);
    expect((await users.sup1!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(200);
    expect((await users.purchasing!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(200);
    expect((await users.coord!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(200);
    expect((await users.sup2!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(404);
    expect((await bAdmin.get(`/api/mr/${mr1}`)).statusCode).toBe(404);
    expect((await users.tech!.c.get(`/api/mr/${mr1}`)).statusCode).toBe(403);
    expect((await users.tech!.c.get('/api/mr')).statusCode).toBe(403);
    expect((await users.tech!.c.get('/api/procurement/summary')).statusCode).toBe(403);
    expect((await users.sup2!.c.get('/api/mr')).json().items).toHaveLength(0);
    expect((await users.sup1!.c.get('/api/mr')).json().items).toHaveLength(1);
    expect((await users.foreman!.c.get('/api/mr?mine=1')).json().items).toHaveLength(1);
    expect((await users.sup1!.c.get('/api/mr?mine=1')).json().items).toHaveLength(0);
  });

  it('the WR detail lists the MR', async () => {
    const d = (await users.coord!.c.get(`/api/work-requests/${wr.own}`)).json();
    expect(d.materialRequests).toEqual([{ id: mr1, mrNo: 1, mrCode: 'MR-1', status: 'submitted', dateRequested: TODAY, lines: 2, requestedByName: expect.stringContaining('foreman') }]);
    expect((await users.coord!.c.get(`/api/work-requests/${wr.other}`)).json().materialRequests).toEqual([]);
  });

  it('the requester edits while it is new, then not any more', async () => {
    const r = await users.foreman!.c.patch(`/api/mr/${mr1}`, {
      purpose: 'stock',
      lines: [{ id: mr1Line, description: 'Ball valve 1 inch (brass)', quantity: 3 }, line('Elbow 1 inch')],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().purpose).toBe('stock');
    expect(r.json().lines.map((l: { description: string; lineNo: number }) => [l.lineNo, l.description])).toEqual([[1, 'Ball valve 1 inch (brass)'], [2, 'Elbow 1 inch']]);
    // a line of another request is refused
    expect((await users.foreman!.c.patch(`/api/mr/${mr1}`, { lines: [{ id: crypto.randomUUID(), description: 'x', quantity: 1 }] })).statusCode).toBe(400);
    // sup1 neither raised it nor is a coordinator
    expect((await users.sup1!.c.patch(`/api/mr/${mr1}`, { purpose: 'new' })).statusCode).toBe(403);
    expect((await users.coord!.c.patch(`/api/mr/${mr1}`, { additionalRequirements: 'Deliver to store 2' })).statusCode).toBe(200);
  });

  it('files: line photos and documents, with access rules', async () => {
    const photo = await upload(users.foreman!.c, mr1, [{ name: 'kind', value: 'line' }, { name: 'lineId', value: mr1Line }, { name: 'file', fileName: 'valve.png', data: PNG, type: 'image/png' }]);
    expect(photo.statusCode).toBe(201);
    const photoId = photo.json().attachments[0].id as string;
    // a PDF is not a photo
    expect((await upload(users.foreman!.c, mr1, [{ name: 'kind', value: 'line' }, { name: 'lineId', value: mr1Line }, { name: 'file', fileName: 'q.pdf', data: PDF }])).statusCode).toBe(415);
    const doc = await upload(users.foreman!.c, mr1, [{ name: 'kind', value: 'doc' }, { name: 'docKind', value: 'quote' }, { name: 'file', fileName: 'quote.pdf', data: PDF, type: 'application/pdf' }]);
    expect(doc.statusCode).toBe(201);
    expect(doc.json().attachments[0]).toMatchObject({ mime: 'application/pdf', docKind: 'quote' });
    const docId = doc.json().attachments[0].id as string;
    // text pretending to be a PDF, and a missing doc type
    expect((await upload(users.foreman!.c, mr1, [{ name: 'kind', value: 'doc' }, { name: 'docKind', value: 'quote' }, { name: 'file', fileName: 'x.pdf', data: Buffer.from('hello'), type: 'application/pdf' }])).statusCode).toBe(415);
    expect((await upload(users.foreman!.c, mr1, [{ name: 'kind', value: 'doc' }, { name: 'file', fileName: 'x.pdf', data: PDF }])).statusCode).toBe(400);

    const d = (await users.purchasing!.c.get(`/api/mr/${mr1}`)).json();
    expect(d.lines[0].photos).toHaveLength(1);
    expect(d.documents).toMatchObject([{ id: docId, docKind: 'quote', mime: 'application/pdf' }]);

    expect((await users.purchasing!.c.get(`/api/attachments/${photoId}`)).statusCode).toBe(200);
    const pdf = await users.sup1!.c.get(`/api/attachments/${docId}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await users.sup2!.c.get(`/api/attachments/${photoId}`)).statusCode).toBe(404);
    expect((await users.tech!.c.get(`/api/attachments/${photoId}`)).statusCode).toBe(404);
    expect((await bAdmin.get(`/api/attachments/${photoId}`)).statusCode).toBe(404);
    // sup1 sees it but did not upload it; the uploader can remove his own photo
    expect((await users.sup1!.c.del(`/api/mr/${mr1}/attachments/${photoId}`)).statusCode).toBe(403);
    expect((await users.foreman!.c.del(`/api/mr/${mr1}/attachments/${photoId}`)).statusCode).toBe(200);
    expect((await users.purchasing!.c.get(`/api/attachments/${photoId}`)).statusCode).toBe(404);
  });

  it('a request without a work request keeps its files private to people who can see the MR', async () => {
    const r = await users.coord!.c.post('/api/mr', mrBody(null, { purchaseType: 'services', lines: [line('Crane hire', { quantity: 1 })] }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ mrNo: 2, wrCode: null });
    expect(r.json().lines[0].kind).toBe('service');
    const id = r.json().id as string;
    const up = await upload(users.coord!.c, id, [{ name: 'kind', value: 'doc' }, { name: 'docKind', value: 'client_approval' }, { name: 'file', fileName: 'ok.png', data: PNG }]);
    expect(up.statusCode).toBe(201);
    const fid = up.json().attachments[0].id as string;
    expect((await ctx.db.query('SELECT work_request_id FROM attachment WHERE id = $1', [fid])).rows[0].work_request_id).toBeNull();
    expect((await users.purchasing!.c.get(`/api/attachments/${fid}`)).statusCode).toBe(200);
    expect((await users.coord!.c.get(`/api/attachments/${fid}`)).statusCode).toBe(200);
    expect((await users.foreman!.c.get(`/api/attachments/${fid}`)).statusCode).toBe(404);
    expect((await users.sup1!.c.get(`/api/mr/${id}`)).statusCode).toBe(404);
    // the requester cancels it while new
    expect((await users.coord!.c.post(`/api/mr/${id}/status`, { to: 'cancelled' })).json().status).toBe('cancelled');
  });

  it('status flow: roles, illegal transitions, history, notifications and the WR timeline', async () => {
    const s = (c: Client, to: string, note?: string) => c.post(`/api/mr/${mr1}/status`, { to, ...(note ? { note } : {}) });
    expect((await s(users.foreman!.c, 'accepted')).statusCode).toBe(403);
    expect((await s(users.foreman!.c, 'ordered')).statusCode).toBe(403);
    expect((await s(users.purchasing!.c, 'closed')).statusCode).toBe(409);
    expect((await s(users.purchasing!.c, 'submitted')).statusCode).toBe(409);
    expect((await s(users.purchasing!.c, 'cancelled')).statusCode).toBe(403);
    expect((await s(users.purchasing!.c, 'rejected')).statusCode).toBe(400); // needs a note

    const acc = await s(users.purchasing!.c, 'accepted');
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ status: 'accepted', assignedTo: users.purchasing!.id });
    expect(acc.json().history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['submitted', 'accepted']);
    // the requester is told; the one who made the change is not
    const told = await ctx.db.query<{ title: string; link: string }>(`SELECT title, link FROM notification WHERE recipient_id = $1 AND event = 'mr.status' AND channel = 'in_app'`, [users.foreman!.id]);
    expect(told.rows).toEqual([{ title: 'MR-1: Pending (under procurement)', link: `/procurement/mr/${mr1}` }]);
    expect((await ctx.db.query(`SELECT 1 FROM notification WHERE recipient_id = $1 AND event = 'mr.status'`, [users.purchasing!.id])).rows).toHaveLength(0);

    // cannot go back, the requester cannot cancel any more or edit
    expect((await s(users.purchasing!.c, 'accepted')).statusCode).toBe(409);
    expect((await s(users.foreman!.c, 'cancelled')).statusCode).toBe(409);
    expect((await users.foreman!.c.patch(`/api/mr/${mr1}`, { purpose: 'new' })).statusCode).toBe(409);

    // procurement may skip steps
    expect((await s(users.purchasing!.c, 'quoted')).statusCode).toBe(200);
    expect((await s(users.purchasing!.c, 'enquiry')).statusCode).toBe(409);
    expect((await s(users.purchasing!.c, 'ordered')).statusCode).toBe(200);
    expect((await s(users.purchasing!.c, 'rejected', 'too late')).statusCode).toBe(409);
    expect((await s(users.foreman!.c, 'closed')).statusCode).toBe(409); // not delivered yet
    expect((await s(users.purchasing!.c, 'delivered')).statusCode).toBe(200);
    expect((await s(users.sup1!.c, 'closed')).statusCode).toBe(403); // not the requester
    const closed = await s(users.foreman!.c, 'closed');
    expect(closed.statusCode).toBe(200);
    expect(closed.json().closedAt).toBeTruthy();
    expect((await s(users.purchasing!.c, 'delivered')).statusCode).toBe(409);

    const d = (await users.coord!.c.get(`/api/work-requests/${wr.own}`)).json();
    const types = d.timeline.map((e: { type: string }) => e.type).filter((t: string) => t.startsWith('mr.'));
    expect(types).toEqual(['mr.submitted', 'mr.status', 'mr.status', 'mr.status', 'mr.status', 'mr.status']);
    expect(d.materialRequests[0].status).toBe('closed');
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE contractor_id = $1 AND action IN ('mr.submit','mr.accepted','mr.closed')`, [aId])).rows.length).toBeGreaterThanOrEqual(3);
  });

  it('rejecting needs a note and the requester cannot touch procurement fields', async () => {
    const r = await users.foreman!.c.post('/api/mr', mrBody(wr.own!, { lines: [line('Silicone sealant', { targetDate: '2026-11-01' })] }));
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    expect((await users.foreman!.c.patch(`/api/mr/${id}/procurement`, { vendorName: 'Test Vendor' })).statusCode).toBe(403);
    expect((await users.sup1!.c.patch(`/api/mr/${id}/procurement`, { vendorName: 'Test Vendor' })).statusCode).toBe(403);
    expect((await users.tech!.c.patch(`/api/mr/${id}/procurement`, { vendorName: 'Test Vendor' })).statusCode).toBe(403);
    const p = await users.purchasing!.c.patch(`/api/mr/${id}/procurement`, {
      assignedTo: users.purchasing!.id, vendorName: 'Test Vendor LLC', vendorContact: 'vendor@example.com', quotationRef: 'Q-TEST-1', quotedAmount: 1250.5, expectedDelivery: '2026-11-20', procurementRemarks: 'Local stock',
    });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ vendorName: 'Test Vendor LLC', quotationRef: 'Q-TEST-1', quotedAmount: 1250.5, expectedDelivery: '2026-11-20', assignedToName: expect.stringContaining('purchasing') });
    // assignee must be a procurement person
    expect((await users.purchasing!.c.patch(`/api/mr/${id}/procurement`, { assignedTo: users.foreman!.id })).statusCode).toBe(400);
    expect((await users.purchasing!.c.patch(`/api/mr/${id}/procurement`, { quotedAmount: -1 })).statusCode).toBe(400);
    // the requester sees the money too (non-technician roles)
    expect((await users.foreman!.c.get(`/api/mr/${id}`)).json().quotedAmount).toBe(1250.5);

    const rej = await users.purchasing!.c.post(`/api/mr/${id}/status`, { to: 'rejected', note: 'Use store stock' });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().history.at(-1)).toMatchObject({ toStatus: 'rejected', note: 'Use store stock' });
    expect((await users.purchasing!.c.patch(`/api/mr/${id}/procurement`, { vendorName: 'X' })).statusCode).toBe(409);
    expect((await upload(users.foreman!.c, id, [{ name: 'kind', value: 'doc' }, { name: 'docKind', value: 'other' }, { name: 'file', fileName: 'a.png', data: PNG }])).statusCode).toBe(409);
  });

  it('summary counts, overdue, filters and search', async () => {
    // fresh requests in several states
    const mk = async (c: Client, extra: Record<string, unknown> = {}, wrCode: string | null = wr.own!) => (await c.post('/api/mr', mrBody(wrCode, extra))).json().id as string;
    const late = await mk(users.foreman!.c, { lines: [line('Cable gland', { targetDate: '2026-11-01' })] }); // new + overdue
    const future = await mk(users.foreman!.c, { lines: [line('Fuse 10A', { targetDate: '2026-12-01' })] }); // new, not overdue
    const enq = await mk(users.foreman!.c, { lines: [line('Conduit 20mm', { targetDate: '2026-11-05' })] });
    await users.purchasing!.c.post(`/api/mr/${enq}/status`, { to: 'enquiry' });
    const dlv = await mk(users.foreman!.c, { lines: [line('Bolts M10', { targetDate: '2026-11-02' })] }); // delivered is not overdue
    await users.purchasing!.c.post(`/api/mr/${dlv}/status`, { to: 'delivered' });
    void future;
    void late;

    const sum = (await users.purchasing!.c.get('/api/procurement/summary')).json();
    expect(sum).toMatchObject({ new: 2, pending: 0, enquiry: 1, quoted: 0, ordered: 0, delivered: 1, closedThisMonth: 1, rejected: 1, overdue: 2 });
    // the zone supervisor sees the same (all of it is in his zone); the other zone sees nothing
    expect((await users.sup1!.c.get('/api/procurement/summary')).json()).toEqual(sum);
    expect((await users.sup2!.c.get('/api/procurement/summary')).json()).toMatchObject({ new: 0, pending: 0, enquiry: 0, quoted: 0, ordered: 0, delivered: 0, closedThisMonth: 0, rejected: 0, overdue: 0 });
    expect((await bAdmin.get('/api/procurement/summary')).json().new).toBe(0);

    const list = async (qs: string) => (await users.purchasing!.c.get(`/api/mr${qs}`)).json().items as { mrNo: number; status: string; overdue: boolean }[];
    expect((await list('?status=submitted')).length).toBe(2);
    expect((await list('?status=submitted,enquiry')).length).toBe(3);
    expect((await list('?overdue=1')).map((i) => i.overdue)).toEqual([true, true]);
    expect((await list(`?wr=${wr.own}`)).length).toBe(6);
    expect((await list('?q=cable')).length).toBe(1);
    expect((await list('?q=MR-1')).map((i) => i.mrNo)).toEqual([1]);
    expect((await list(`?q=${wr.own}`)).length).toBe(6);
    expect((await users.purchasing!.c.get('/api/mr?status=bogus')).statusCode).toBe(400);
    // coordinator sees the company-wide MR without a WR (cancelled)
    expect((await users.coord!.c.get('/api/mr')).json().items.length).toBe(7);
  });
});
