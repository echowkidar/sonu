import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { notify } from '../src/notifications/index.js';
import { Client, createContractorWithAdmin, makeTestApp, setupPlatformAdmin, type TestContext } from './helpers.js';

describe('migrations, health, errors, mail, notifications', () => {
  let ctx: TestContext;
  let platform: Client;
  let admin: Client;
  let contractorId: string;
  let adminUserId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    platform = await setupPlatformAdmin(ctx);
    ({ admin, contractorId, adminUserId } = await createContractorWithAdmin(platform, ctx, 'MISC', 'admin.misc@example.com'));
  });
  afterAll(async () => ctx?.close());

  it('migrations are idempotent (second and third run apply nothing)', async () => {
    const second = await runMigrations(ctx.db, ctx.config.migrationsDir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('001_init.sql');
    const third = await runMigrations(ctx.db, ctx.config.migrationsDir);
    expect(third.applied).toEqual([]);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(n.rows[0].n).toBe(second.skipped.length);
  });

  it('health answers and checks the database', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('error format and 404s (no web build present)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    expect((await ctx.app.inject({ method: 'GET', url: '/some/page' })).statusCode).toBe(404);
    const bad = await admin.post('/api/admin/work-teams', { code: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'validation_error', details: expect.any(Array) });
  });

  it('VAPID keys are generated once, private part encrypted', async () => {
    const r = await ctx.db.query(`SELECT value, secret_id FROM app_setting WHERE key = 'vapid'`);
    expect(r.rows[0].value.publicKey).toMatch(/^[A-Za-z0-9_-]{80,90}$/);
    expect(r.rows[0].secret_id).toBeTruthy();
  });

  it('log driver is used when nothing is configured (outbox)', async () => {
    const res = await admin.post('/api/admin/mail/test');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, driver: 'log', to: 'admin.misc@example.com' });
    const o = await ctx.db.query(`SELECT subject FROM mail_outbox WHERE to_address = 'admin.misc@example.com' ORDER BY created_at DESC LIMIT 1`);
    expect(o.rows[0].subject).toBe('SONU test e-mail');
  });

  it('smtp driver: "Send test e-mail" goes through nodemailer (jsonTransport) to the caller', async () => {
    const put = await admin.put('/api/admin/mail', {
      driver: 'smtp', fromAddress: 'maintenance@example.com', fromName: 'MISC Maintenance', replyTo: 'helpdesk@example.com',
      smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'maintenance@example.com', password: 'App-Pw-123456',
    });
    expect(put.statusCode).toBe(200);
    const before = ctx.sent.length;
    const res = await admin.post('/api/admin/mail/test');
    expect(res.statusCode).toBe(200);
    expect(res.json().driver).toBe('smtp');
    const mail = ctx.sent[before]!;
    expect(mail.options).toMatchObject({ host: 'smtp.example.com', port: 587, auth: { user: 'maintenance@example.com', pass: 'App-Pw-123456' } });
    expect(mail.message.subject).toBe('SONU test e-mail');
    expect(JSON.stringify(mail.message.to)).toContain('admin.misc@example.com');
    expect(JSON.stringify(mail.message.from)).toContain('maintenance@example.com');
    // Invitations now use the contractor sender too
    await admin.post('/api/admin/users', { email: 'new.coord@example.com', fullName: 'New Coordinator', role: 'coordinator' });
    expect(ctx.sent.some((m) => JSON.stringify(m.message.to).includes('new.coord@example.com') && m.message.text?.includes('/accept-invite?token='))).toBe(true);
  });

  it('oauth2 driver builds an XOAUTH2 transport for Microsoft 365', async () => {
    const put = await admin.put('/api/admin/mail', {
      driver: 'oauth2', oauthProvider: 'microsoft', oauthUser: 'maintenance@example.com', oauthClientId: 'client-id-1', oauthTenant: 'tenant-1',
      oauthClientSecret: 'cs-value', oauthRefreshToken: 'rt-value', fromAddress: 'maintenance@example.com',
    });
    expect(put.json()).toMatchObject({ driver: 'oauth2', hasClientSecret: true, hasRefreshToken: true });
    const before = ctx.sent.length;
    const res = await admin.post('/api/admin/mail/test');
    expect(res.statusCode).toBe(200);
    expect(ctx.sent[before]!.options).toMatchObject({
      host: 'smtp.office365.com',
      auth: { type: 'OAuth2', user: 'maintenance@example.com', clientId: 'client-id-1', accessUrl: expect.stringContaining('/tenant-1/') },
    });
  });

  it('platform-level mail settings are the fallback for contractors without their own', async () => {
    await admin.put('/api/admin/mail', { driver: 'log' });
    const p = await platform.put('/api/admin/mail', { driver: 'smtp', fromAddress: 'noreply@example.com', smtpHost: 'smtp.platform.example.com', smtpPort: 25 });
    expect(p.json().scope).toBe('platform');
    const before = ctx.sent.length;
    expect((await admin.post('/api/admin/mail/test')).json().driver).toBe('smtp');
    expect(ctx.sent[before]!.options).toMatchObject({ host: 'smtp.platform.example.com' });
  });

  it('notify() creates in-app rows and e-mails per preferences', async () => {
    const res = await notify(ctx.app, { contractorId, event: 'wr.returned', recipients: [adminUserId], title: 'WR 100001 returned by QF', link: '/wr/100001' });
    expect(res.created).toBeGreaterThanOrEqual(2); // in_app + email (+ push queued)
    expect(res.emailed).toBe(1);
    const list = (await admin.get('/api/notifications')).json();
    expect(list.unread).toBe(1);
    expect(list.items[0].title).toBe('WR 100001 returned by QF');
    await admin.post(`/api/notifications/${list.items[0].id}/read`);
    expect((await admin.get('/api/notifications')).json().unread).toBe(0);
    // Recipients of another contractor are ignored
    const other = await notify(ctx.app, { contractorId: null, event: 'x', recipients: [adminUserId], title: 'x' });
    expect(other.created).toBe(0);
  });

  it('own profile and notification preferences', async () => {
    const r = await admin.patch('/api/me/profile', { mobile: '+97455550199', notifyWhatsapp: true, quietHoursStart: '22:00', quietHoursEnd: '06:30' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mobile: '+97455550199', notifyWhatsapp: true, quietHoursStart: '22:00', quietHoursEnd: '06:30', mobileVerified: false });
    expect((await admin.patch('/api/me/profile', { role: 'manager' })).statusCode).toBe(400);
  });
});

describe('static web app with SPA fallback', () => {
  let ctx: TestContext;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonu-web-'));
  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>SONU</title><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    ctx = await makeTestApp({ WEB_DIST: dir });
  });
  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves files, falls back to index.html for app routes, keeps JSON 404 for /api', async () => {
    const root = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>SONU</title>');
    const deep = await ctx.app.inject({ method: 'GET', url: '/admin/users?tab=1' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('id="root"');
    const asset = await ctx.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await ctx.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    const api = await ctx.app.inject({ method: 'GET', url: '/api/unknown' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    expect((await ctx.app.inject({ method: 'GET', url: '/../package.json' })).body).not.toContain('@sonu/server');
  });
});

describe('TRUST_PROXY', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeTestApp({ TRUST_PROXY: '1' });
  });
  afterAll(async () => ctx?.close());

  it('uses CF-Connecting-IP and sets Secure cookies for https behind the proxy', async () => {
    const c = new Client(ctx.app);
    const res = await c.req(
      'POST',
      '/api/setup',
      { code: ctx.app.setupState.code, email: 'platform@example.com', fullName: 'Platform Owner', password: 'Correct-Horse-42' },
      { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '198.51.100.7' } },
    );
    expect(res.statusCode).toBe(201);
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
    const a = await ctx.db.query(`SELECT ip FROM audit_log WHERE action = 'setup.platform_admin_created'`);
    expect(a.rows[0].ip).toBe('198.51.100.7');
  });
});
