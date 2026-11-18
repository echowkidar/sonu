import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMasterRows, parseExport, parseTrackerWorkbook, readSheet } from '@sonu/core';
import { Client, createContractorWithAdmin, makeTestApp, PASSWORD, setupPlatformAdmin, tokenFromOutbox, type TestContext } from './helpers.js';
import { runDeadlineSweep } from '../src/ops/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(here, '..', '..', 'fixtures');
const fx = (n: string) => fs.readFileSync(path.join(FIX, n));
const fxJson = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
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

async function upload(ctx: TestContext, c: Client, url: string, parts: Part[]) {
  const { payload, contentType } = multipart(parts);
  return ctx.app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, 'x-requested-with': 'sonu', cookie: c.cookie } });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);

describe('ops: imports, work requests, dashboard, jobs, exports, deadlines', () => {
  let ctx: TestContext;
  let aAdmin: Client;
  let bAdmin: Client;
  let aId: string;
  const users: Record<string, { c: Client; id: string }> = {};
  let firstBatch: string;
  let jobId: string;
  let attachmentId: string;
  let team1Code: string;

  async function makeUser(admin: Client, email: string, role: string, workTeamIds: string[] = []) {
    const r = await admin.post('/api/admin/users', { email, fullName: `${role} ${email.split('@')[0]}`, role, workTeamIds });
    if (r.statusCode !== 201) throw new Error(`create user ${r.body}`);
    const token = await tokenFromOutbox(ctx.db, email);
    const c = new Client(ctx.app);
    const acc = await c.post('/api/auth/accept-invite', { token, password: PASSWORD });
    if (acc.statusCode !== 200) throw new Error(`accept ${acc.body}`);
    return { c, id: r.json().user.id as string };
  }

  beforeAll(async () => {
    ctx = await makeTestApp();
    ctx.app.opsClock.today = TODAY;
    const platform = await setupPlatformAdmin(ctx);
    ({ admin: aAdmin, contractorId: aId } = await createContractorWithAdmin(platform, ctx, 'OPSA', 'admin.opsa@example.com'));
    ({ admin: bAdmin } = await createContractorWithAdmin(platform, ctx, 'OPSB', 'admin.opsb@example.com'));
    const t1 = (await aAdmin.post('/api/admin/work-teams', { code: 'TEST-WT-1' })).json().id ?? (await aAdmin.get('/api/admin/work-teams')).json().items.find((t: { code: string }) => t.code === 'TEST-WT-1').id;
    const t2 = (await aAdmin.post('/api/admin/work-teams', { code: 'TEST-WT-2' })).json().id ?? (await aAdmin.get('/api/admin/work-teams')).json().items.find((t: { code: string }) => t.code === 'TEST-WT-2').id;
    const teams = (await aAdmin.get('/api/admin/work-teams')).json().items as { id: string; code: string }[];
    const id1 = teams.find((t) => t.code === 'TEST-WT-1')?.id ?? t1;
    const id2 = teams.find((t) => t.code === 'TEST-WT-2')?.id ?? t2;
    users.coord = await makeUser(aAdmin, 'coord@example.com', 'coordinator');
    users.manager = await makeUser(aAdmin, 'manager@example.com', 'manager');
    users.purchasing = await makeUser(aAdmin, 'purchasing@example.com', 'purchasing');
    users.sup1 = await makeUser(aAdmin, 'sup1@example.com', 'supervisor', [id1]);
    users.sup2 = await makeUser(aAdmin, 'sup2@example.com', 'supervisor', [id2]);
    users.tech = await makeUser(aAdmin, 'tech@example.com', 'technician', [id1]);
    users.foreman = await makeUser(aAdmin, 'foreman@example.com', 'foreman', [id1]);
    team1Code = 'TEST-WT-1';
  }, 120_000);
  afterAll(async () => ctx?.close());

  const count = async (sql: string, p: unknown[] = []) => (await ctx.db.query<{ n: number }>(sql, p)).rows[0]!.n;

  it('refuses a renamed column with 422 naming the caption and writes no rows', async () => {
    const r = await upload(ctx, users.coord!.c, '/api/imports', [{ name: 'file', fileName: 'pending.xlsx', data: fx('pending-work-requests-renamed-column.xlsx') }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('missing_caption');
    expect(r.json().error.details.missingCaptions).toEqual(['Agreed Target Date']);
    expect(r.json().error.message).toContain('Agreed Target Date');
    expect(await count('SELECT count(*)::int n FROM work_request WHERE contractor_id = $1', [aId])).toBe(0);
    expect(await count('SELECT count(*)::int n FROM list_snapshot WHERE contractor_id = $1', [aId])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM import_batch WHERE contractor_id = $1 AND status = 'failed'`, [aId])).toBe(1);
  });

  it('technicians cannot import; supervisors neither', async () => {
    const r = await upload(ctx, users.tech!.c, '/api/imports', [{ name: 'file', fileName: 'p.xlsx', data: fx('pending-work-requests.xlsx') }]);
    expect(r.statusCode).toBe(403);
    const s = await upload(ctx, users.sup1!.c, '/api/imports', [{ name: 'file', fileName: 'p.xlsx', data: fx('pending-work-requests.xlsx') }]);
    expect(s.statusCode).toBe(403);
  });

  it('imports the main fixtures + tracker and the dashboard matches expected-counts.json', async () => {
    const r = await upload(ctx, users.coord!.c, '/api/imports', [{ name: 'file', fileName: 'pending-work-requests.xlsx', data: fx('pending-work-requests.xlsx') }]);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, listKey: 'pending_work_requests', rowsRead: 60, new: 60, gone: 0 });
    firstBatch = r.json().batchId;
    const a = await upload(ctx, users.coord!.c, '/api/imports', [
      { name: 'listKey', value: 'review_approved_estimations' },
      { name: 'file', fileName: 'review-approved-estimations.xlsx', data: fx('review-approved-estimations.xlsx') },
    ]);
    expect(a.statusCode).toBe(201);

    const p = await upload(ctx, users.coord!.c, '/api/imports/tracker', [{ name: 'file', fileName: 'tracker-master.xlsx', data: fx('tracker-master.xlsx') }]);
    expect(p.statusCode).toBe(201);
    expect(p.json().matched).toBe(60);
    expect(p.json().unknownWrCodes).toEqual([]);
    const conf = await users.coord!.c.post(`/api/imports/tracker/confirm/${p.json().id}`, {});
    expect(conf.statusCode).toBe(200);
    expect(conf.json().written).toBeGreaterThan(50);
    expect((await users.coord!.c.post(`/api/imports/tracker/confirm/${p.json().id}`, {})).statusCode).toBe(409);

    const exp = fxJson('expected-counts.json');
    const d = await users.coord!.c.get('/api/dashboard');
    expect(d.statusCode).toBe(200);
    const s = d.json();
    expect(s.today).toBe(TODAY);
    expect(s.totalOutstanding).toBe(exp.totalOutstanding);
    expect(s.breached).toBe(exp.breached);
    expect(s.backlogKpi).toBe(exp.backlogKpi);
    expect(s.averageAge).toBe(exp.averageDaysSinceAssigned);
    const nz = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
    const flat = (m: { rows: string[]; cells: Record<string, Record<string, number>> }) => Object.fromEntries(m.rows.map((st) => [st, nz(m.cells[st]!)]));
    expect(flat(s.byDiscipline)).toEqual(exp.statusByDiscipline);
    expect(flat(s.byZone)).toEqual(exp.statusByZone);
    expect(flat(s.byFacility)).toEqual(exp.statusByFacility);
    expect(s.byYear).toEqual(exp.byYear);
    expect(nz(s.rfeTimeFrameSplit)).toEqual(exp.rfeTimeFrameSplit);
    expect(s.descriptiveStages).toBeNull();
    expect(s.needsActionToday.unownedCount).toBe(60);
  });

  it('dashboard filters, In Progress and Priority Requests match the list filters', async () => {
    const c = users.coord!.c;
    const all = (await c.get('/api/dashboard')).json();
    expect(all.filterOptions.zones.length).toBeGreaterThan(0);
    expect(all.filterOptions.facilities.length).toBeGreaterThan(0);
    const zone = all.filterOptions.zones[0] as string;
    const byZone = (await c.get(`/api/dashboard?zone=${encodeURIComponent(zone.toUpperCase())}`)).json();
    expect(byZone.totalOutstanding).toBeGreaterThan(0);
    expect(byZone.totalOutstanding).toBeLessThan(all.totalOutstanding);
    // filter options come from the unfiltered scope
    expect(byZone.filterOptions).toEqual(all.filterOptions);
    const listZone = (await c.get(`/api/work-requests?zone=${encodeURIComponent(zone)}&pageSize=500`)).json();
    expect(listZone.total).toBe(byZone.totalOutstanding);
    const bld = all.filterOptions.buildings[0] as { facility: string; building: string };
    const byB = (await c.get(`/api/dashboard?facility=${encodeURIComponent(bld.facility)}&building=${encodeURIComponent(bld.building)}`)).json();
    const listB = (await c.get(`/api/work-requests?facility=${encodeURIComponent(bld.facility)}&building=${encodeURIComponent(bld.building)}&pageSize=500`)).json();
    expect(byB.totalOutstanding).toBe(listB.total);

    // fictional target dates: today (in), today+10 (in), today+11 (out), yesterday (breached, out), none (out)
    const day = (n: number) => new Date(Date.UTC(2026, 10, 9 + n)).toISOString().slice(0, 10);
    const rows = (await ctx.db.query<{ id: string; wr_code: string; t: string | null; s: string | null }>(
      `SELECT id, wr_code, agreed_target_date::text AS t, wr_status AS s FROM work_request WHERE contractor_id = $1 AND gone_at IS NULL ORDER BY wr_code LIMIT 6`, [aId],
    )).rows;
    const targets: (string | null)[] = [day(0), day(10), day(11), day(-1), null, day(3)];
    const statuses = ['Assigned to Work Order', 'Assigned to Work Order', 'Assigned to Work Order', 'Assigned to Work Order', 'Assigned to Work Order', 'Completed'];
    const statusBefore = (await c.get('/api/dashboard')).json().inProgress as number;
    try {
      for (const [i, r] of rows.entries()) {
        await ctx.db.query('UPDATE work_request SET agreed_target_date = $2::timestamptz, wr_status = $3 WHERE id = $1', [r.id, targets[i] ? `${targets[i]}T00:00:00Z` : null, statuses[i]]);
      }
      const d = (await c.get('/api/dashboard')).json();
      const pr = (await c.get('/api/work-requests?tdWithin=10&pageSize=500')).json();
      expect(d.priorityRequests).toBe(pr.total);
      const codes = pr.items.map((i: { wrCode: string }) => i.wrCode);
      expect(codes).toEqual(expect.arrayContaining([rows[0]!.wr_code, rows[1]!.wr_code]));
      for (const i of [2, 3, 4, 5]) expect(codes).not.toContain(rows[i]!.wr_code);
      // an "Issued and In Process" WR counts as In Progress; a completed one does not
      await ctx.db.query(`UPDATE work_request SET wr_status = 'Issued and In Process' WHERE id = $1`, [rows[0]!.id]);
      await ctx.db.query(`UPDATE work_request SET wr_status = 'issued and in process' WHERE id = $1`, [rows[1]!.id]);
      const d2 = (await c.get('/api/dashboard')).json();
      const ip = (await c.get('/api/work-requests?inProgress=1&pageSize=500')).json();
      expect(d2.inProgress).toBe(ip.total);
      expect(ip.items.map((i: { wrCode: string }) => i.wrCode)).toEqual(expect.arrayContaining([rows[0]!.wr_code, rows[1]!.wr_code]));
      expect(d2.inProgress).toBeGreaterThanOrEqual(2);
      expect(statusBefore).toBeGreaterThanOrEqual(0);
    } finally {
      for (const r of rows) await ctx.db.query('UPDATE work_request SET agreed_target_date = $2::timestamptz, wr_status = $3 WHERE id = $1', [r.id, r.t, r.s]);
    }
  });

  it('computed columns on the API equal core', async () => {
    const list = (await users.coord!.c.get('/api/work-requests?pageSize=500')).json();
    expect(list.total).toBe(60);
    const pend = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
    const rfe = parseExport('review_approved_estimations', fx('review-approved-estimations.xlsx'));
    const t = parseTrackerWorkbook(fx('tracker-master.xlsx'));
    if (!pend.ok || !rfe.ok || !t.ok) throw new Error('parse');
    const { loadLookups } = await import('@sonu/core');
    const lookups = loadLookups(JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'assets', 'tracker-lookups.json'), 'utf8')));
    const typed = new Map(t.rows.map((x) => [x.wrCode, { status: x.status, fcRemarks: x.fcRemarks || null }]));
    const lookup = new Map(rfe.rows.map((x) => [String(x.wrCode), { submittedOn: x.rfeSubmittedOn as string | null, approvedOn: x.rfeApprovedOn as string | null }]));
    const rows = buildMasterRows(pend.rows, { today: TODAY, rfeLookup: lookup, typed, lookups });
    for (const m of rows) {
      const item = list.items.find((i: { wrCode: string }) => i.wrCode === m.wrCode);
      const { rfeTimeFrameKind, ...rest } = item.computed;
      for (const [k, v] of Object.entries(rest)) expect([m.wrCode, k, v]).toEqual([m.wrCode, k, (m as unknown as Record<string, unknown>)[k]]);
      expect(rfeTimeFrameKind).toBeDefined();
    }
    const one = (await users.coord!.c.get('/api/work-requests/9100001')).json();
    expect(one.marafiqUrl).toBe('https://marafiq.qf.org.qa/archibus/gc-qf-ab-wr-console-report-details.axvw?wr.wr_id=9100001');
    expect(one.requestor).toBe('Requestor 001');
    expect(one.timeline.some((e: { type: string }) => e.type === 'wr.seen')).toBe(true);
  });

  it('identical re-import reports no changes and raises no events', async () => {
    const before = await count('SELECT count(*)::int n FROM wr_event WHERE contractor_id = $1', [aId]);
    const r = await upload(ctx, users.coord!.c, '/api/imports', [{ name: 'file', fileName: 'again.xlsx', data: fx('pending-work-requests.xlsx') }]);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, unchanged: true, new: 0, changed: 0, gone: 0, events: 0 });
    expect(await count('SELECT count(*)::int n FROM wr_event WHERE contractor_id = $1', [aId])).toBe(before);
    const hist = (await users.coord!.c.get('/api/imports')).json().items;
    expect(hist[0].result).toBe('unchanged');
    const exp = (await users.coord!.c.get('/api/imports/expected')).json().items;
    expect(exp.find((x: { key: string }) => x.key === 'pending_work_requests').rows).toBe(60);
    const asOf = (await users.tech!.c.get('/api/data-as-of')).json();
    expect(asOf.lists.pending_work_requests).toBeTruthy();
    expect(firstBatch).toBeTruthy();
  });

  it('owner / criterion / status / remarks are set via PATCH with role checks', async () => {
    // supervisor of TEST-WT-2 takes ownership of 9100001 (TEST-WT-2 in the fixture)
    const w1 = (await users.coord!.c.get('/api/work-requests/9100001')).json();
    const sup = w1.workTeamCode === 'TEST-WT-2' ? users.sup2! : users.sup1!;
    const other = sup === users.sup2 ? users.sup1! : users.sup2!;
    expect((await other.c.patch('/api/work-requests/9100001', { takeOwnership: true })).statusCode).toBe(404);
    const t = await sup.c.patch('/api/work-requests/9100001', { takeOwnership: true, criterion: 3 });
    expect(t.statusCode).toBe(200);
    expect(t.json().internal).toMatchObject({ ownerId: sup.id, criterion: 3 });
    expect((await sup.c.patch('/api/work-requests/9100001', { contractorStatus: 'Not a status' })).statusCode).toBe(400);
    expect((await sup.c.patch('/api/work-requests/9100001', { ownerId: other.id })).statusCode).toBe(403);
    const r = await users.coord!.c.patch('/api/work-requests/9100005', { ownerId: users.sup1!.id, criterion: 2, contractorStatus: 'Awaiting Quote - TDGI', fcRemarks: 'Kept remark' });
    expect(r.statusCode).toBe(200);
    const bulk = await users.coord!.c.post('/api/work-requests/bulk', { codes: ['9100008', '9100009', '0000000'], criterion: 1 });
    expect(bulk.json()).toEqual({ updated: 2, notFound: ['0000000'] });
    const timeline = (await users.coord!.c.get('/api/work-requests/9100005')).json().timeline.map((e: { type: string }) => e.type);
    expect(timeline).toEqual(expect.arrayContaining(['wr.owner_changed', 'wr.criterion_set', 'wr.status_set', 'wr.remarks_set']));
  });

  it('changed fixture: exactly the expected events, gone WRs flagged, SONU data untouched', async () => {
    const before = (await ctx.db.query(`SELECT w.wr_code, i.owner_id, i.criterion, i.contractor_status, i.fc_remarks FROM work_request w JOIN wr_internal i ON i.work_request_id = w.id WHERE w.contractor_id = $1 ORDER BY 1`, [aId])).rows;
    const r = await upload(ctx, users.coord!.c, '/api/imports', [{ name: 'file', fileName: 'pending-work-requests-changed.xlsx', data: fx('pending-work-requests-changed.xlsx') }]);
    expect(r.statusCode).toBe(201);
    const exp = fxJson('expected-events.json').events as { type: string; key: string; fields?: string[] }[];
    const got = (await ctx.db.query<{ type: string; payload: { key: string; changes?: { field: string }[] } }>('SELECT type, payload FROM wr_event WHERE import_batch_id = $1', [r.json().batchId])).rows.map((e) => {
      const o: { type: string; key: string; fields?: string[] } = { type: e.type, key: e.payload.key };
      if (e.payload.changes) o.fields = e.payload.changes.map((c) => c.field);
      return o;
    });
    const sort = (x: { type: string; key: string }[]) => [...x].sort((a, b) => a.key.localeCompare(b.key) || a.type.localeCompare(b.type));
    expect(sort(got)).toEqual(sort(exp));
    expect(r.json()).toMatchObject({ gone: 4, new: 3 });
    const gone = (await ctx.db.query<{ wr_code: string }>('SELECT wr_code FROM work_request WHERE contractor_id = $1 AND gone_at IS NOT NULL ORDER BY 1', [aId])).rows.map((x) => x.wr_code);
    expect(gone).toEqual(['9100005', '9100017', '9100033', '9100048']);
    const after = (await ctx.db.query(`SELECT w.wr_code, i.owner_id, i.criterion, i.contractor_status, i.fc_remarks FROM work_request w JOIN wr_internal i ON i.work_request_id = w.id WHERE w.contractor_id = $1 AND w.wr_code = ANY($2) ORDER BY 1`, [aId, before.map((b: { wr_code: string }) => b.wr_code)])).rows;
    expect(after).toEqual(before);
    expect(await count(`SELECT count(*)::int n FROM notification WHERE recipient_id = $1 AND event = 'wr.gone' AND channel = 'in_app'`, [users.sup1!.id])).toBe(1);
    // list hides gone WRs; detail still works
    expect((await users.coord!.c.get('/api/work-requests')).json().total).toBe(59);
    expect((await users.coord!.c.get('/api/work-requests/9100005')).json().goneAt).toBeTruthy();
  });

  it('assignment -> start -> update with photo -> done, with notifications and role checks', async () => {
    const list = (await users.coord!.c.get(`/api/work-requests?workTeam=${team1Code}`)).json().items;
    const code = list[0].wrCode as string;
    // supervisor of zone 2 cannot assign in zone 1
    expect((await users.sup2!.c.post(`/api/work-requests/${code}/assignments`, { assigneeId: users.tech!.id })).statusCode).toBe(404);
    expect((await users.sup1!.c.post(`/api/work-requests/${code}/assignments`, { assigneeId: users.manager!.id })).statusCode).toBe(400);
    expect((await users.tech!.c.get('/api/work-requests')).json().total).toBe(0);
    const a = await users.sup1!.c.post(`/api/work-requests/${code}/assignments`, { assigneeId: users.tech!.id, plannedDate: TODAY, note: 'Check the AC' });
    expect(a.statusCode).toBe(201);
    jobId = a.json().id;
    expect(await count(`SELECT count(*)::int n FROM notification WHERE recipient_id = $1 AND event = 'job.assigned'`, [users.tech!.id])).toBeGreaterThan(0);

    const mine = (await users.tech!.c.get('/api/my-jobs')).json();
    expect(mine.todayJobs.map((j: { id: string }) => j.id)).toEqual([jobId]);
    const twr = (await users.tech!.c.get('/api/work-requests')).json();
    expect(twr.total).toBe(1);
    expect(twr.items[0].requestor).toBeUndefined();
    expect(twr.items[0].estimatedTotalCost).toBeUndefined();
    expect((await users.tech!.c.get('/api/dashboard')).statusCode).toBe(403);
    expect((await users.foreman!.c.get('/api/team-jobs')).json().items.map((j: { id: string }) => j.id)).toContain(jobId);

    expect((await upload(ctx, users.tech!.c, `/api/jobs/${jobId}/updates`, [{ name: 'note', value: 'x' }])).statusCode).toBe(409);
    expect((await users.sup1!.c.post(`/api/jobs/${jobId}/start`, {})).statusCode).toBe(403);
    expect((await users.tech!.c.post(`/api/jobs/${jobId}/start`, {})).statusCode).toBe(200);
    expect((await users.tech!.c.post(`/api/jobs/${jobId}/start`, {})).statusCode).toBe(409);

    const fake = await upload(ctx, users.tech!.c, `/api/jobs/${jobId}/updates`, [
      { name: 'note', value: 'fake' },
      { name: 'photo', fileName: 'evil.jpg', data: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/jpeg' },
    ]);
    expect(fake.statusCode).toBe(415);
    const up = await upload(ctx, users.tech!.c, `/api/jobs/${jobId}/updates`, [
      { name: 'note', value: 'Half done' },
      { name: 'photo', fileName: '../../client-name.png', data: PNG, type: 'image/png' },
    ]);
    expect(up.statusCode).toBe(201);
    attachmentId = up.json().attachments[0];
    const att = (await ctx.db.query<{ file_path: string; file_name: string }>('SELECT file_path, file_name FROM attachment WHERE id = $1', [attachmentId])).rows[0]!;
    expect(att.file_path).toMatch(new RegExp(`^${aId}/[0-9a-f-]{36}\\.png$`));
    expect(att.file_name).not.toContain('client-name');

    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}`, headers: { cookie: users.tech!.c.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.rawPayload.equals(PNG)).toBe(true);
    expect((await users.sup2!.c.get(`/api/attachments/${attachmentId}`)).statusCode).toBe(404);

    const done = await users.tech!.c.post(`/api/jobs/${jobId}/done`, { note: 'Finished' });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('done');
    expect(await count(`SELECT count(*)::int n FROM notification WHERE recipient_id = $1 AND event = 'job.done'`, [users.sup1!.id])).toBeGreaterThan(0);
    const detail = (await users.tech!.c.get(`/api/jobs/${jobId}`)).json();
    expect(detail.updates.map((u: { statusTo: string | null }) => u.statusTo)).toEqual(['assigned', 'started', null, 'done']);
  });

  it('master export re-parses with parseTrackerWorkbook; RFE file name and content', async () => {
    const m = await ctx.app.inject({ method: 'GET', url: '/api/exports/master.xlsx', headers: { cookie: users.coord!.c.cookie } });
    expect(m.statusCode).toBe(200);
    const t = parseTrackerWorkbook(m.rawPayload);
    expect(t.ok).toBe(true);
    expect(t.rows.length).toBe(59);
    expect(t.rows.find((r) => r.wrCode === '9100008')).toBeTruthy();
    expect(await count(`SELECT count(*)::int n FROM audit_log WHERE contractor_id = $1 AND action = 'export.master'`, [aId])).toBe(1);
    expect((await users.tech!.c.get('/api/exports/master.xlsx')).statusCode).toBe(403);

    const line = { vendorItemName: 'Test item', uom: 'EA', lineNumber: '1', poNumber: 'BPA-1', bpaItem: 'L1', accountCode: 'ACC', estQty: 2, unitPrice: 50, markUp: 0 };
    const rf = await ctx.app.inject({ method: 'POST', url: '/api/work-requests/9100002/rfe-file', payload: { lines: [line] }, headers: { cookie: users.coord!.c.cookie, 'x-requested-with': 'sonu' } });
    expect(rf.statusCode).toBe(200);
    expect(rf.headers['content-disposition']).toContain('rfe-9100002.xlsx');
    const sheet = readSheet(rf.rawPayload, { knownCaptions: ['Srl', 'WR No', 'Line Type', 'Vendor Item Name', 'UOM', 'Amount'] });
    expect(sheet.rows[0]).toMatchObject({ 'Vendor Item Name': 'Test item', Amount: 100 });
    const bad = await users.coord!.c.post('/api/work-requests/9100002/rfe-file', { lines: [{ ...line, uom: '' }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.problems[0].field).toBe('uom');
  });

  it('deadline sweep raises a warning once, not twice', async () => {
    const items = (await users.coord!.c.get('/api/work-requests?pageSize=500&rfeTimeFrame=valid')).json().items as { wrCode: string; computed: { daysSinceRequested: number } }[];
    const target = items.find((i) => i.computed.daysSinceRequested >= 8 && i.computed.daysSinceRequested <= 14);
    expect(target).toBeTruthy();
    await users.coord!.c.patch(`/api/work-requests/${target!.wrCode}`, { ownerId: users.sup1!.id, criterion: 3 });
    const wr = (await users.coord!.c.get(`/api/work-requests/${target!.wrCode}`)).json();
    expect(wr.deadline).toMatchObject({ ruleKey: 'rfe_submit_14d', state: 'amber', breached: false });
    await runDeadlineSweep(ctx.app, aId);
    await runDeadlineSweep(ctx.app, aId);
    const n = await count(`SELECT count(*)::int n FROM notification WHERE event = 'deadline.warning' AND channel = 'in_app' AND work_request_id = $1`, [wr.id]);
    expect(n).toBe(1);
    const internal = (await ctx.db.query<{ breach_level: number; due_at: Date | null }>('SELECT breach_level, due_at FROM wr_internal WHERE work_request_id = $1', [wr.id])).rows[0]!;
    expect(internal.breach_level).toBe(1);
    expect(internal.due_at).toBeTruthy();
    expect(await count(`SELECT count(*)::int n FROM notification WHERE event = 'wr.not_owned' AND recipient_id = $1 AND channel = 'in_app'`, [users.coord!.id])).toBeGreaterThan(0);
  });

  it('my-work groups the caller\'s WRs', async () => {
    const r = (await users.sup1!.c.get('/api/my-work')).json();
    expect(r.owned).toBeGreaterThan(0);
    expect(Object.keys(r.groups)).toEqual(expect.arrayContaining(['take_ownership', 'classify', 'estimate_due', 'returned', 'answer_qf', 'assign_technician']));
    const meta = (await users.coord!.c.get('/api/meta')).json();
    expect(meta.contractorStatuses.length).toBe(15);
  });

  it('0 RFE: convert, stage 6, local purchases with receipts, monthly report, undo rules', async () => {
    const cands = (await users.coord!.c.get(`/api/work-requests?workTeam=${team1Code}&pageSize=500`)).json().items as { wrCode: string; wrStatus: string | null; internal: { ownerId: string | null } }[];
    let code = '';
    for (const c of cands) {
      if (c.internal.ownerId || /complet|clos/i.test(c.wrStatus ?? '')) continue;
      const d = (await users.coord!.c.get(`/api/work-requests/${c.wrCode}`)).json();
      if (!d.rfe?.approvedOn) {
        code = c.wrCode;
        break;
      }
    }
    expect(code).toBeTruthy();
    // the dashboard stage tiles exist once a wr_dashboard import has succeeded
    await ctx.db.query(`INSERT INTO import_batch (contractor_id, list_key, source, status) VALUES ($1, 'wr_dashboard', 'manual', 'ok')`, [aId]);
    const stage6 = async () => {
      const d = (await users.coord!.c.get('/api/dashboard')).json();
      return { n: d.descriptiveStages.find((s: { stage: number }) => s.stage === 6) as { label: string; count: number }, zeroRfe: d.zeroRfe as { monthJobs: number; monthSpent: number; withoutReceipt: number } };
    };
    const before = await stage6();
    expect(before.n.label).toBe('6. In Progress');

    // not the owner -> 403; foreman / purchasing -> 403; amount 100 -> 400
    const nonOwner = await users.sup1!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 40 });
    expect(nonOwner.statusCode).toBe(403);
    expect(nonOwner.json().error.message).toBe('Take ownership first.');
    expect((await users.foreman!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 40 })).statusCode).toBe(403);
    expect((await users.purchasing!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 40 })).statusCode).toBe(403);
    expect((await users.sup1!.c.patch(`/api/work-requests/${code}`, { takeOwnership: true, criterion: 3, contractorStatus: 'Awaiting Quote - TDGI' })).statusCode).toBe(200);
    expect((await users.sup1!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 100 })).statusCode).toBe(400);
    expect((await users.sup1!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 0 })).statusCode).toBe(400);
    // no purchases before converting
    const early = await upload(ctx, users.sup1!.c, `/api/work-requests/${code}/purchases`, [{ name: 'item', value: 'x' }, { name: 'amount', value: '5' }, { name: 'purchasedOn', value: TODAY }]);
    expect(early.statusCode).toBe(400);

    const conv = await users.sup1!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 45.5, note: 'Two taps and a seal' });
    expect(conv.statusCode).toBe(200);
    expect(conv.json().internal).toMatchObject({ criterion: 2, contractorStatus: 'Work In Progress - TDGI', statusSource: 'manual', zeroRfe: { amount: 45.5, note: 'Two taps and a seal' } });
    expect(conv.json().qfStage).toBe(6);
    expect((await users.sup1!.c.post(`/api/work-requests/${code}/zero-rfe`, { amount: 10 })).statusCode).toBe(409);
    const after = await stage6();
    expect(after.n.count).toBe(before.n.count + 1);
    expect(after.n.label).toBe('6. In Progress');
    expect(after.zeroRfe).toEqual({ monthJobs: 1, monthSpent: 0, withoutReceipt: 1 });
    expect((await users.coord!.c.get('/api/work-requests?qfStage=6')).json().items.map((i: { wrCode: string }) => i.wrCode)).toContain(code);
    expect(await count(`SELECT count(*)::int n FROM wr_event WHERE type = 'wr.zero_rfe' AND work_request_id = $1`, [conv.json().id])).toBe(1);

    // purchases
    const future = await upload(ctx, users.sup1!.c, `/api/work-requests/${code}/purchases`, [
      { name: 'item', value: 'Tap' }, { name: 'amount', value: '12' }, { name: 'purchasedOn', value: '2099-01-01' },
    ]);
    expect(future.statusCode).toBe(400);
    const fakeImg = await upload(ctx, users.sup1!.c, `/api/work-requests/${code}/purchases`, [
      { name: 'item', value: 'Tap' }, { name: 'amount', value: '12' }, { name: 'purchasedOn', value: TODAY },
      { name: 'photo', fileName: 'r.jpg', data: Buffer.from('not an image'), type: 'image/jpeg' },
    ]);
    expect(fakeImg.statusCode).toBe(415);
    const add = await upload(ctx, users.sup1!.c, `/api/work-requests/${code}/purchases`, [
      { name: 'item', value: 'Mixer tap' }, { name: 'amount', value: '30.25' }, { name: 'purchasedOn', value: TODAY }, { name: 'pettyCashRef', value: 'PC-001' },
      { name: 'photo', fileName: 'receipt.png', data: PNG, type: 'image/png' },
    ]);
    expect(add.statusCode).toBe(201);
    const pid = add.json().id as string;
    expect(add.json().attachments).toHaveLength(1);
    const det = (await users.sup1!.c.get(`/api/work-requests/${code}`)).json();
    expect(det.localPurchases).toHaveLength(1);
    expect(det.localPurchases[0]).toMatchObject({ item: 'Mixer tap', amount: 30.25, purchasedOn: TODAY, pettyCashRef: 'PC-001' });
    const rid = det.localPurchases[0].attachments[0].id as string;
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/attachments/${rid}`, headers: { cookie: users.sup1!.c.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PNG)).toBe(true);
    expect((await users.sup2!.c.get(`/api/attachments/${rid}`)).statusCode).toBe(404);

    const rep = (await users.coord!.c.get(`/api/zero-rfe?month=${TODAY.slice(0, 7)}`)).json();
    expect(rep.totals).toEqual({ jobs: 1, expected: 45.5, spent: 30.25, withoutReceipt: 0 });
    expect(rep.items[0]).toMatchObject({ wrCode: code, purchases: 1, receipts: 1, expected: 45.5, spent: 30.25, qfStageLabel: '6. In Progress' });
    expect((await users.coord!.c.get('/api/zero-rfe?month=2020-01')).json().totals.jobs).toBe(0);
    expect((await users.tech!.c.get('/api/zero-rfe')).statusCode).toBe(403);
    expect((await bAdmin.get('/api/zero-rfe')).json().totals.jobs).toBe(0);

    // undo is coordinator-level only and blocked while purchases exist
    expect((await users.sup1!.c.del(`/api/work-requests/${code}/zero-rfe`)).statusCode).toBe(403);
    expect((await users.coord!.c.del(`/api/work-requests/${code}/zero-rfe`)).statusCode).toBe(409);
    // only the creator or a coordinator deletes a purchase
    expect((await users.foreman!.c.del(`/api/work-requests/${code}/purchases/${pid}`)).statusCode).toBe(403);
    expect((await users.sup1!.c.del(`/api/work-requests/${code}/purchases/${pid}`)).statusCode).toBe(200);
    expect(await count(`SELECT count(*)::int n FROM attachment WHERE owner_type = 'local_purchase'`)).toBe(0);
    const undo = await users.coord!.c.del(`/api/work-requests/${code}/zero-rfe`);
    expect(undo.statusCode).toBe(200);
    expect(undo.json().internal).toMatchObject({ criterion: 3, contractorStatus: 'Awaiting Quote - TDGI', zeroRfe: null });
    expect((await stage6()).n.count).toBe(before.n.count);
  });

  it('tenant isolation: contractor B sees nothing of A', async () => {
    expect((await bAdmin.get('/api/work-requests')).json().total).toBe(0);
    expect((await bAdmin.get('/api/work-requests/9100001')).statusCode).toBe(404);
    expect((await bAdmin.patch('/api/work-requests/9100001', { criterion: 1 })).statusCode).toBe(404);
    expect((await bAdmin.post('/api/work-requests/9100001/assignments', { assigneeId: users.tech!.id })).statusCode).toBe(404);
    expect((await bAdmin.post('/api/work-requests/9100001/rfe-file', { lines: [] })).statusCode).toBe(404);
    expect((await bAdmin.get(`/api/jobs/${jobId}`)).statusCode).toBe(404);
    expect((await bAdmin.post(`/api/jobs/${jobId}/start`, {})).statusCode).toBe(404);
    expect((await bAdmin.get(`/api/attachments/${attachmentId}`)).statusCode).toBe(404);
    expect((await bAdmin.get('/api/imports')).json().items).toEqual([]);
    expect((await bAdmin.get('/api/team-jobs')).json().items).toEqual([]);
    expect((await bAdmin.get('/api/dashboard')).json().totalOutstanding).toBe(0);
    const m = await ctx.app.inject({ method: 'GET', url: '/api/exports/master.xlsx', headers: { cookie: bAdmin.cookie } });
    const t = parseTrackerWorkbook(m.rawPayload);
    expect(t.ok && t.rows.length).toBe(0);
    const p = await upload(ctx, aAdmin, '/api/imports/tracker', [{ name: 'file', fileName: 'tracker-master.xlsx', data: fx('tracker-master.xlsx') }]);
    expect((await bAdmin.post(`/api/imports/tracker/confirm/${p.json().id}`, {})).statusCode).toBe(404);
  });

  it('the legacy .xls fixture imports (contractor B)', async () => {
    const r = await upload(ctx, bAdmin, '/api/imports', [{ name: 'file', fileName: 'pending-work-requests.xls', data: fx('pending-work-requests.xls') }]);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, listKey: 'pending_work_requests', rowsRead: 60, new: 60 });
    expect((await bAdmin.get('/api/work-requests')).json().total).toBe(60);
    // A's data unchanged by B's import
    expect((await users.coord!.c.get('/api/work-requests')).json().total).toBe(59);
  });
});
