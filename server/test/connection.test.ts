import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, defaultLogger } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { initApp } from '../src/startup.js';
import { workerToken } from '../src/secrets.js';
import { MARAFIQ_LIST_KEYS, runSchedulerOnce, type ImportRunner } from '../src/connection/index.js';
import { ASSETS_DIR, Client, createContractorWithAdmin, createTestDatabase, setupPlatformAdmin, type TestContext } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PW = 'Marafiq-Conn-Pw-77qZ';
const PW2 = 'Marafiq-New-Pw-88xY';
// Sunday 2026-11-15 08:00 in Qatar: inside service hours.
const T0 = new Date('2026-11-15T05:00:00Z');

/** Test app whose log output is captured (to prove the password never reaches a log line). */
async function makeLoggedApp(logs: string[]): Promise<TestContext> {
  const databaseUrl = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    PUBLIC_URL: 'https://sonu.example.test',
    ASSETS_DIR,
    WEB_DIST: path.join(here, 'no-web-dist'),
    UPLOAD_DIR: path.join(here, '..', '.data', 'test-uploads'),
    LOG_LEVEL: 'trace',
  });
  const db: Pool = createPool(databaseUrl, 5);
  const logger = { ...(defaultLogger('trace') as object), stream: { write: (s: string) => logs.push(s) } };
  const app = await buildApp({ config, pool: db, logger: logger as never });
  await initApp(app);
  return { app, db, config, sent: [], async close() { await app.close(); await db.end(); } };
}

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const b = `----sonu${crypto.randomBytes(6).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/vnd.ms-excel\r\n\r\n`));
  parts.push(file.content, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

describe('Marafiq connection', () => {
  const logs: string[] = [];
  const responses: string[] = [];
  let ctx: TestContext;
  let app: FastifyInstance;
  let platform: Client;
  let admin: Client;
  let adminB: Client;
  let A: string;
  let adminUserId: string;
  let now = T0;
  const imports: Parameters<ImportRunner>[1][] = [];

  const worker = async (method: 'GET' | 'POST', url: string, opts: { token?: string | null; headers?: Record<string, string>; payload?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = opts.token === undefined ? workerToken() : opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    return app.inject({ method, url, headers, payload: opts.payload as never });
  };
  const keep = <T extends { body: string }>(r: T) => {
    responses.push(r.body);
    return r;
  };
  const jobsOf = async () => (await ctx.db.query(`SELECT * FROM worker_job WHERE contractor_id = $1 ORDER BY created_at`, [A])).rows;

  beforeAll(async () => {
    ctx = await makeLoggedApp(logs);
    app = ctx.app;
    app.comm.now = () => now;
    platform = await setupPlatformAdmin(ctx);
    ({ admin, contractorId: A, adminUserId } = await createContractorWithAdmin(platform, ctx, 'CONA', 'admin.cona@example.com'));
    ({ admin: adminB } = await createContractorWithAdmin(platform, ctx, 'CONB', 'admin.conb@example.com'));
  });
  afterAll(async () => ctx?.close());

  it('the server list keys mirror the worker allow-list (drift test)', () => {
    const src = fs.readFileSync(path.resolve(here, '..', '..', 'worker', 'src', 'allowlist.ts'), 'utf8');
    const block = src.slice(src.indexOf('export const LISTS = deepFreeze({'), src.indexOf('} as const satisfies Record<string, ListDef>)'));
    const keys = [...block.matchAll(/^ {2}([a-z0-9_]+): \{/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    expect([...MARAFIQ_LIST_KEYS]).toEqual(keys);
  });

  it('is off by default: no jobs, no password', async () => {
    const r = keep(await admin.get('/api/admin/marafiq-connection'));
    expect(r.json()).toMatchObject({ mode: 'off', hasPassword: false, paused: false, state: 'idle', project: 'MARAFIQ' });
    expect(r.json().schedule.serviceHours).toEqual({ start: '07:30', end: '15:30' });
    expect(r.json().enabledLists).toEqual([...MARAFIQ_LIST_KEYS]);
    expect(await runSchedulerOnce(app)).toEqual([]);
    expect((await admin.post('/api/admin/marafiq-connection/test')).statusCode).toBe(409);
  });

  it('refuses an http base URL (localhost only with ALLOW_INSECURE_PORTAL=1)', async () => {
    expect((await admin.put('/api/admin/marafiq-connection', { baseUrl: 'http://portal.example.com' })).statusCode).toBe(400);
    expect((await admin.put('/api/admin/marafiq-connection', { baseUrl: 'http://localhost:4010' })).statusCode).toBe(400);
    process.env.ALLOW_INSECURE_PORTAL = '1';
    try {
      expect((await admin.put('/api/admin/marafiq-connection', { baseUrl: 'http://127.0.0.1:4010' })).statusCode).toBe(200);
      expect((await admin.put('/api/admin/marafiq-connection', { baseUrl: 'http://portal.example.com' })).statusCode).toBe(400);
    } finally {
      delete process.env.ALLOW_INSECURE_PORTAL;
    }
    expect((await admin.put('/api/admin/marafiq-connection', { enabledLists: ['not_a_list'] })).statusCode).toBe(400);
  });

  it('read_only + password: the scheduler creates one sync job, never two open', async () => {
    const r = keep(await admin.put('/api/admin/marafiq-connection', { baseUrl: 'https://portal.example.com', username: 'svc-sonu', password: PW, mode: 'read_only' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hasPassword: true, mode: 'read_only' });
    const created = await runSchedulerOnce(app);
    expect(created).toHaveLength(1);
    const jobs = await jobsOf();
    expect(jobs[0]).toMatchObject({ kind: 'sync', status: 'queued' });
    expect(jobs[0].lists).toEqual([...MARAFIQ_LIST_KEYS]); // all due the first time (in service hours)
    expect(await runSchedulerOnce(app)).toEqual([]);
    expect((await admin.post('/api/admin/marafiq-connection/test')).statusCode).toBe(409); // a job is open
  });

  it('internal API: token in constant time, 404 through the tunnel, password only in jobs/next', async () => {
    expect((await worker('GET', '/internal/worker/jobs/next', { token: null })).statusCode).toBe(401);
    expect((await worker('GET', '/internal/worker/jobs/next', { token: 'f'.repeat(64) })).statusCode).toBe(401);
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray']) {
      const t = await worker('GET', '/internal/worker/jobs/next', { headers: { [h]: '203.0.113.9' } });
      expect(t.statusCode).toBe(404);
      expect(t.body).not.toContain(PW);
    }
    expect((await worker('GET', '/internal/worker/jobs/next', { token: 'wrong', headers: { 'cf-ray': 'abc' } })).statusCode).toBe(404);

    const r = await worker('GET', '/internal/worker/jobs/next');
    expect(r.statusCode).toBe(200);
    const job = r.json();
    expect(job).toMatchObject({ kind: 'sync', connection: { baseUrl: 'https://portal.example.com', project: 'MARAFIQ', username: 'svc-sonu', password: PW } });
    expect(job.lists).toEqual([...MARAFIQ_LIST_KEYS]);
    expect((await worker('GET', '/internal/worker/jobs/next')).statusCode).toBe(204);
    const used = await ctx.db.query(`SELECT details::text AS d FROM audit_log WHERE action = 'marafiq_connection.used' AND contractor_id = $1`, [A]);
    expect(used.rowCount).toBe(1);
    expect(used.rows[0].d).not.toContain(PW);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM sync_run WHERE worker_job_id = $1`, [job.jobId])).rows[0].n).toBe(MARAFIQ_LIST_KEYS.length);
  });

  it('file hand-over uses the real import path by default, and calls the runner with the contractor and sync run', async () => {
    const jobId = (await jobsOf())[0].id;
    const file = { name: 'pending.xls', content: Buffer.from('fake-xls-bytes') };
    // The real ops import runner is wired at start-up: unreadable bytes fail cleanly and load nothing.
    expect(typeof (app as unknown as { importRunner?: unknown }).importRunner).toBe('function');
    const real = await worker('POST', `/internal/worker/jobs/${jobId}/file`, multipart({ listKey: 'pending_work_requests' }, file));
    expect(real.statusCode).toBe(200);
    expect(real.json()).toMatchObject({ ok: false });
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM work_request WHERE contractor_id = $1`, [A])).rows[0].n).toBe(0);

    (app as unknown as { importRunner: ImportRunner }).importRunner = async (_app, input) => {
      imports.push(input);
      if (input.listKey === 'wr_dashboard') return { ok: false, error: { code: 'missing_caption', message: 'Caption "WR Code" not found', missingCaptions: ['WR Code'] } };
      return { ok: true, batchId: crypto.randomUUID(), listKey: input.listKey, rowsRead: 12 };
    };
    const ok = await worker('POST', `/internal/worker/jobs/${jobId}/file`, multipart({ listKey: 'pending_work_requests' }, file));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, rowsRead: 12 });
    expect(imports[0]).toMatchObject({ contractorId: A, fileName: 'pending.xls', listKey: 'pending_work_requests' });
    expect(imports[0]!.buffer.toString()).toBe('fake-xls-bytes');
    const run = (await ctx.db.query(`SELECT id, result, rows_read FROM sync_run WHERE worker_job_id = $1 AND list_key = 'pending_work_requests'`, [jobId])).rows[0];
    expect(imports[0]!.syncRunId).toBe(run.id);
    expect(run).toMatchObject({ result: 'ok', rows_read: 12 });

    const bad = await worker('POST', `/internal/worker/jobs/${jobId}/file`, multipart({ listKey: 'wr_dashboard' }, file));
    expect(bad.json()).toMatchObject({ ok: false, error: 'Caption "WR Code" not found', missingCaptions: ['WR Code'] });
    expect((await worker('POST', `/internal/worker/jobs/${jobId}/file`, multipart({ listKey: 'evil_list' }, file))).statusCode).toBe(400);
    expect((await worker('POST', `/internal/worker/jobs/${crypto.randomUUID()}/file`, multipart({ listKey: 'issue_wr' }, file))).statusCode).toBe(404);
    expect((await worker('POST', `/internal/worker/jobs/${jobId}/file`, { ...multipart({ listKey: 'issue_wr' }, file), token: 'nope' })).statusCode).toBe(401);
  });

  it('ok result updates state and runs; the next job comes when lists are due again', async () => {
    const jobId = (await jobsOf())[0].id;
    const res = await worker('POST', `/internal/worker/jobs/${jobId}/result`, {
      headers: { 'content-type': 'application/json' },
      payload: { status: 'ok', signInAttempts: 1, lists: MARAFIQ_LIST_KEYS.map((key) => ({ key, ok: key !== 'wr_dashboard', rows: 12, ...(key === 'wr_dashboard' ? { error: 'caption mismatch' } : {}) })) },
    });
    expect(res.statusCode).toBe(200);
    expect((await worker('POST', `/internal/worker/jobs/${jobId}/result`, { headers: { 'content-type': 'application/json' }, payload: { status: 'ok', signInAttempts: 0, lists: [] } })).statusCode).toBe(409);
    const h = keep(await admin.get('/api/admin/marafiq-connection/health')).json();
    expect(h).toMatchObject({ state: 'ok', paused: false, worker: { running: true, hint: null } });
    expect(h.lastSignInAt).toBeTruthy();
    expect(h.lists.find((l: any) => l.key === 'issue_wr')).toMatchObject({ lastRows: 12 });
    expect(h.lists.find((l: any) => l.key === 'wr_dashboard').lastError).toBe('caption mismatch');
    expect(h.recentRuns.length).toBeGreaterThan(5);

    now = new Date(T0.getTime() + 10 * 60_000);
    expect(await runSchedulerOnce(app)).toEqual([]); // nothing due yet
    now = new Date(T0.getTime() + 31 * 60_000);
    expect(await runSchedulerOnce(app)).toHaveLength(1);
    const j = (await jobsOf()).at(-1)!;
    expect(j.lists).not.toContain('boq_details'); // daily list
    expect(j.lists).toContain('issue_wr');

    now = new Date(now.getTime() + 3 * 60_000);
    expect((await admin.get('/api/admin/marafiq-connection/health')).json().worker).toMatchObject({ running: false, hint: expect.stringMatching(/Worker not running/) });
  });

  it('pause cancels queued jobs and stops the scheduler; resume starts it again', async () => {
    expect(keep(await admin.post('/api/admin/marafiq-connection/pause')).json().paused).toBe(true);
    expect((await jobsOf()).at(-1)!.status).toBe('cancelled');
    now = new Date(now.getTime() + 60 * 60_000);
    expect(await runSchedulerOnce(app)).toEqual([]);
    expect((await worker('GET', '/internal/worker/jobs/next')).statusCode).toBe(204);
    expect(keep(await admin.post('/api/admin/marafiq-connection/resume')).json().paused).toBe(false);
    expect(await runSchedulerOnce(app)).toHaveLength(1);
  });

  it('signin_failed → needs_attention, admin alerted, no further jobs until a new password or Resume', async () => {
    const job = (await worker('GET', '/internal/worker/jobs/next')).json();
    expect(job.connection.password).toBe(PW);
    await worker('POST', `/internal/worker/jobs/${job.jobId}/result`, {
      headers: { 'content-type': 'application/json' },
      payload: { status: 'signin_failed', signInAttempts: 2, lists: [{ key: 'issue_wr', ok: false, error: 'not read: sign-in failed' }], message: 'Internal error' },
    });
    const view = keep(await admin.get('/api/admin/marafiq-connection')).json();
    expect(view.state).toBe('needs_attention');
    const n = (await admin.get('/api/notifications')).json();
    expect(n.items.find((x: any) => x.title === 'Marafiq connection needs attention')).toBeTruthy();
    expect((await adminB.get('/api/notifications')).json().items.find((x: any) => x.title === 'Marafiq connection needs attention')).toBeUndefined();
    now = new Date(now.getTime() + 2 * 3600_000);
    expect(await runSchedulerOnce(app)).toEqual([]);
    expect((await admin.post('/api/admin/marafiq-connection/test')).statusCode).toBe(409);

    // Resume clears it
    await admin.post('/api/admin/marafiq-connection/resume');
    expect((await admin.get('/api/admin/marafiq-connection')).json().state).toBe('idle');
    const ids = await runSchedulerOnce(app);
    expect(ids).toHaveLength(1);

    // Again failed; this time a new password clears it
    const j2 = (await worker('GET', '/internal/worker/jobs/next')).json();
    await worker('POST', `/internal/worker/jobs/${j2.jobId}/result`, { headers: { 'content-type': 'application/json' }, payload: { status: 'signin_failed', signInAttempts: 2, lists: [] } });
    expect((await admin.get('/api/admin/marafiq-connection')).json().state).toBe('needs_attention');
    now = new Date(now.getTime() + 2 * 3600_000);
    expect(await runSchedulerOnce(app)).toEqual([]);
    keep(await admin.put('/api/admin/marafiq-connection', { password: PW2 }));
    expect((await admin.get('/api/admin/marafiq-connection')).json().state).toBe('idle');
    expect(await runSchedulerOnce(app)).toHaveLength(1);
    expect((await worker('GET', '/internal/worker/jobs/next')).json().connection.password).toBe(PW2);
  });

  it('Test connection creates a test job when ready; actions are audited', async () => {
    const j = (await jobsOf()).find((x) => x.status === 'running')!;
    await worker('POST', `/internal/worker/jobs/${j.id}/result`, { headers: { 'content-type': 'application/json' }, payload: { status: 'ok', signInAttempts: 1, lists: [] } });
    const t = await admin.post('/api/admin/marafiq-connection/test');
    expect(t.statusCode).toBe(202);
    const job = (await worker('GET', '/internal/worker/jobs/next')).json();
    expect(job).toMatchObject({ kind: 'test', lists: [] });
    const actions = (await ctx.db.query<{ action: string }>(`SELECT DISTINCT action FROM audit_log WHERE contractor_id = $1`, [A])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining([
      'marafiq_connection.update', 'marafiq_connection.used', 'marafiq_connection.pause', 'marafiq_connection.resume',
      'marafiq_connection.test', 'marafiq_connection.needs_attention', 'marafiq_connection.job_result',
    ]));
  });

  it('tenant isolation and role checks', async () => {
    const b = (await adminB.get('/api/admin/marafiq-connection')).json();
    expect(b).toMatchObject({ mode: 'off', hasPassword: false, username: null });
    expect((await adminB.get(`/api/admin/marafiq-connection?contractorId=${A}`)).statusCode).toBe(403);
    expect((await adminB.post(`/api/admin/marafiq-connection/pause?contractorId=${A}`)).statusCode).toBe(403);
    expect((await platform.get('/api/admin/marafiq-connection')).statusCode).toBe(400);
    const p = keep(await platform.get(`/api/admin/marafiq-connection?contractorId=${A}`));
    expect(p.json().hasPassword).toBe(true);
    expect((await new Client(app).get('/api/admin/marafiq-connection/health')).statusCode).toBe(401);
    void adminUserId;
  });

  it('the Marafiq password never appears in admin responses, audit rows or logs', async () => {
    responses.push(
      (await admin.get('/api/admin/marafiq-connection')).body,
      (await admin.get('/api/admin/marafiq-connection/health')).body,
      (await admin.get('/api/admin/audit?pageSize=500')).body,
      (await platform.get('/api/admin/audit?pageSize=500')).body,
      (await admin.get('/api/notifications')).body,
    );
    for (const b of responses) for (const s of [PW, PW2]) expect(b).not.toContain(s);
    const audit = await ctx.db.query(`SELECT details::text AS d, coalesce(summary, '') AS s FROM audit_log`);
    for (const r of audit.rows) for (const s of [PW, PW2]) expect(r.d + r.s).not.toContain(s);
    const tables = await ctx.db.query(`SELECT row_to_json(x)::text AS j FROM marafiq_connection x UNION ALL SELECT row_to_json(w)::text FROM worker_job w UNION ALL SELECT row_to_json(s)::text FROM sync_run s`);
    for (const r of tables.rows) for (const s of [PW, PW2]) expect(r.j).not.toContain(s);
    expect(logs.length).toBeGreaterThan(20);
    for (const line of logs) for (const s of [PW, PW2]) expect(line).not.toContain(s);
  });
});
