import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, createContractorWithAdmin, makeTestApp, tokenFromOutbox, type TestContext } from './helpers.js';

describe('setup, sign-in, CSRF, rate limit, invitations, roles', () => {
  let ctx: TestContext;
  let platform: Client;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => ctx?.close());

  it('first run: setup code required, creates the platform admin once', async () => {
    const c = new Client(ctx.app);
    expect((await c.get('/api/setup')).json()).toEqual({ needed: true });
    expect(ctx.app.setupState.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const wrong = await c.post('/api/setup', { code: 'AAAA-BBBB-CCCC', email: 'platform@example.com', fullName: 'Platform Owner', password: PASSWORD });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('setup_code_invalid');

    const weak = await c.post('/api/setup', { code: ctx.app.setupState.code, email: 'platform@example.com', fullName: 'Platform Owner', password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('validation_error');

    const ok = await c.post('/api/setup', { code: ctx.app.setupState.code, email: 'Platform@Example.com', fullName: 'Platform Owner', password: PASSWORD });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user.role).toBe('platform_admin');
    expect(ok.json().user.email).toBe('platform@example.com');
    expect(JSON.stringify(ok.json())).not.toMatch(/password_hash|scrypt\$/);
    expect(ok.headers['set-cookie']).toMatch(/sonu_session=.*HttpOnly.*SameSite=Lax/i);
    platform = c;

    expect((await new Client(ctx.app).get('/api/setup')).json()).toEqual({ needed: false });
    const again = await new Client(ctx.app).post('/api/setup', { code: 'K7QF-2M9X-HV4C', email: 'x@example.com', fullName: 'X Y', password: PASSWORD });
    expect(again.statusCode).toBe(403);
  });

  it('login / me / logout', async () => {
    const c = new Client(ctx.app);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
    const bad = await c.post('/api/auth/login', { email: 'platform@example.com', password: 'Wrong-password-1' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: { code: 'invalid_credentials', message: expect.any(String) } });
    const ok = await c.post('/api/auth/login', { email: 'PLATFORM@example.com', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).json().user.email).toBe('platform@example.com');
    expect((await c.post('/api/auth/logout')).statusCode).toBe(200);
    // Old cookie no longer works
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('Secure cookie when https arrives through a trusted proxy', async () => {
    const c = new Client(ctx.app);
    const res = await c.req('POST', '/api/auth/login', { email: 'platform@example.com', password: PASSWORD }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.statusCode).toBe(200);
    // TRUST_PROXY is off in this app → not trusted → not Secure.
    expect(String(res.headers['set-cookie'])).not.toMatch(/Secure/);
  });

  it('CSRF: mutating API requests need X-Requested-With: sonu', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/api/auth/login', { email: 'platform@example.com', password: PASSWORD }, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
    const signedIn = await platform.req('POST', '/api/admin/contractors', { code: 'NOCSRF', name: 'No Csrf', admin: { fullName: 'A B', email: 'nocsrf@example.com' } }, { csrf: false });
    expect(signedIn.statusCode).toBe(403);
  });

  it('rate limit: 5 wrong passwords per e-mail, then 429', async () => {
    const c = new Client(ctx.app);
    for (let i = 0; i < 5; i++) {
      expect((await c.post('/api/auth/login', { email: 'victim@example.com', password: `Wrong-${i}-pass` })).statusCode).toBe(401);
    }
    const blocked = await c.post('/api/auth/login', { email: 'victim@example.com', password: 'Wrong-x-pass' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('invitation: e-mailed link sets the password once; resend invalidates the old link', async () => {
    const { admin, contractorId } = await createContractorWithAdmin(platform, ctx, 'INVA', 'admin.inva@example.com');
    const me = (await admin.get('/api/auth/me')).json();
    expect(me.user.role).toBe('contractor_admin');
    expect(me.user.emailVerified).toBe(true);
    expect(me.contractor.code).toBe('INVA');
    expect(me.user).toMatchObject({ id: expect.any(String), email: 'admin.inva@example.com', fullName: 'Admin INVA', role: 'contractor_admin', contractorId: expect.any(String), contractorName: 'INVA Facilities W.L.L.' });

    const created = await admin.post('/api/admin/users', { email: 'tech.one@example.com', fullName: 'Tech One', role: 'technician' });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.status).toBe('invited');
    const outbox = await ctx.db.query('SELECT body_text FROM mail_outbox WHERE to_address = $1', ['tech.one@example.com']);
    expect(outbox.rows[0].body_text).toContain('https://sonu.example.test/accept-invite?token=');
    const firstToken = await tokenFromOutbox(ctx.db, 'tech.one@example.com');

    // Resend → old token revoked
    const resend = await admin.post(`/api/admin/users/${created.json().user.id}/resend-invite`);
    expect(resend.statusCode).toBe(200);
    const secondToken = await tokenFromOutbox(ctx.db, 'tech.one@example.com');
    expect(secondToken).not.toBe(firstToken);
    const tech = new Client(ctx.app);
    expect((await tech.post('/api/auth/accept-invite', { token: firstToken, password: PASSWORD })).statusCode).toBe(410);

    const check = await tech.post('/api/auth/invitation/check', { token: secondToken });
    expect(check.json()).toEqual({ email: 'tech.one@example.com', fullName: 'Tech One' });
    const acc = await tech.post('/api/auth/accept-invite', { token: secondToken, password: PASSWORD });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().user.status).toBe('active');
    expect(acc.json().user.contractorId).toBe(contractorId);
    // Single use
    expect((await new Client(ctx.app).post('/api/auth/accept-invite', { token: secondToken, password: PASSWORD })).statusCode).toBe(410);

    // Expired link
    const another = await admin.post('/api/admin/users', { email: 'tech.two@example.com', fullName: 'Tech Two', role: 'technician' });
    const t2 = await tokenFromOutbox(ctx.db, 'tech.two@example.com');
    await ctx.db.query(`UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [another.json().user.id]);
    expect((await new Client(ctx.app).post('/api/auth/accept-invite', { token: t2, password: PASSWORD })).statusCode).toBe(410);
    const exp = await ctx.db.query(`SELECT expires_at - created_at AS ttl FROM invitation WHERE user_id = $1 AND kind = 'invite' ORDER BY created_at LIMIT 1`, [created.json().user.id]);
    expect(exp.rows[0].ttl.days).toBe(7);
  });

  it('role guard: technician cannot use admin routes; signed-out gets 401', async () => {
    const tech = new Client(ctx.app);
    await tech.post('/api/auth/login', { email: 'tech.one@example.com', password: PASSWORD });
    expect((await tech.get('/api/admin/users')).statusCode).toBe(403);
    expect((await tech.post('/api/admin/users', { email: 'x@example.com', fullName: 'X Y', role: 'manager' })).statusCode).toBe(403);
    expect((await tech.get('/api/admin/contractors')).statusCode).toBe(403);
    expect((await tech.get('/api/admin/audit')).statusCode).toBe(403);
    expect((await new Client(ctx.app).get('/api/admin/users')).statusCode).toBe(401);
    // Platform admin has no contractor → work-data style route refuses
    expect((await platform.get('/api/contractor')).statusCode).toBe(403);
  });

  it('deactivated user is signed out and cannot sign in', async () => {
    const admin = new Client(ctx.app);
    await admin.post('/api/auth/login', { email: 'admin.inva@example.com', password: PASSWORD });
    const tech = new Client(ctx.app);
    await tech.post('/api/auth/login', { email: 'tech.one@example.com', password: PASSWORD });
    const id = (await tech.get('/api/auth/me')).json().user.id;
    expect((await admin.post(`/api/admin/users/${id}/deactivate`)).json().status).toBe('inactive');
    expect((await tech.get('/api/auth/me')).statusCode).toBe(401);
    expect((await new Client(ctx.app).post('/api/auth/login', { email: 'tech.one@example.com', password: PASSWORD })).statusCode).toBe(401);
  });

  it('password reset by e-mail link', async () => {
    const c = new Client(ctx.app);
    const r = await c.post('/api/auth/forgot-password', { email: 'admin.inva@example.com' });
    expect(r.statusCode).toBe(200);
    const unknown = await c.post('/api/auth/forgot-password', { email: 'nobody@example.com' });
    expect(unknown.json()).toEqual(r.json());
    const token = await tokenFromOutbox(ctx.db, 'admin.inva@example.com', 'reset-password');
    const newPw = 'Another-Pass-77';
    expect((await c.post('/api/auth/reset-password', { token, password: newPw })).statusCode).toBe(200);
    expect((await c.post('/api/auth/reset-password', { token, password: newPw })).statusCode).toBe(410);
    expect((await c.post('/api/auth/login', { email: 'admin.inva@example.com', password: newPw })).statusCode).toBe(200);
  });

  it('every sign-in is audited', async () => {
    const r = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('auth.login', 'auth.login_failed')`);
    expect(r.rows[0].n).toBeGreaterThan(5);
  });
});
