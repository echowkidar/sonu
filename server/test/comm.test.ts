import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notify, dispatchPending } from '../src/notifications/index.js';
import { getWhatsAppChannel, LINKED_SESSION_WARNING, normalizeNumber, WaConsentError, WaRateLimitedError } from '../src/comm/whatsapp/index.js';
import type { WaLibrary } from '../src/comm/whatsapp/index.js';
import type { PushSendFn } from '../src/comm/push.js';
import { Client, createContractorWithAdmin, makeTestApp, setupPlatformAdmin, type TestContext } from './helpers.js';

// Sunday 2026-11-15, 10:00 in Qatar (UTC+3) — outside the default quiet hours.
const DAY = new Date('2026-11-15T07:00:00Z');
// 23:00 in Qatar — inside 21:00–07:00.
const NIGHT = new Date('2026-11-15T20:00:00Z');
const MORNING_END = new Date('2026-11-16T04:00:00Z'); // 07:00 Qatar
const SESSION_MARKER = 'WA-SESSION-SECRET-Zq81';

class FakeSocket {
  handlers = new Map<string, ((a: any) => void)[]>();
  sent: { jid: string; text: string }[] = [];
  loggedOut = false;
  ended = false;
  user: { id: string } | null = null;
  ev = { on: (e: string, fn: (a: any) => void) => this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]) };
  emit(e: string, arg: unknown) {
    for (const fn of this.handlers.get(e) ?? []) fn(arg);
  }
  async sendMessage(jid: string, c: { text: string }) {
    this.sent.push({ jid, text: c.text });
    return { key: { id: `msg-${this.sent.length}` } };
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

function fakeLibrary(sockets: FakeSocket[]): WaLibrary {
  return {
    name: 'fake',
    initAuthCreds: () => ({ noiseKey: SESSION_MARKER, registered: false }),
    serialize: (v) => JSON.stringify(v),
    deserialize: (s) => JSON.parse(s),
    reviveKey: (_t, v) => v,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      setTimeout(() => s.emit('connection.update', { connection: 'connecting', qr: '2@fake-qr-payload' }), 5);
      return s;
    },
    loggedOutCodes: [401, 403],
    restartCodes: [515],
  };
}

async function addUser(ctx: TestContext, contractorId: string, p: { email: string; role: string; notifyEmail?: boolean; notifyPush?: boolean; notifyWhatsapp?: boolean; mobile?: string | null; qs?: string | null; qe?: string | null }) {
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO app_user (contractor_id, email, full_name, role, status, notify_email, notify_push, notify_whatsapp, mobile, quiet_hours_start, quiet_hours_end)
     VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10) RETURNING id`,
    [contractorId, p.email, p.email.split('@')[0], p.role, p.notifyEmail ?? true, p.notifyPush ?? true, p.notifyWhatsapp ?? false, p.mobile ?? null, p.qs ?? null, p.qe ?? null],
  );
  return r.rows[0]!.id;
}

async function rows(ctx: TestContext, userId: string, event: string) {
  return (await ctx.db.query('SELECT * FROM notification WHERE recipient_id = $1 AND event = $2 ORDER BY channel', [userId, event])).rows;
}

describe('notifications, web push, WhatsApp', () => {
  let ctx: TestContext;
  let platform: Client;
  let adminA: Client;
  let adminB: Client;
  let A: string;
  let B: string;
  let adminAId: string;
  const pushes: { endpoint: string; payload: string }[] = [];
  let pushStatus: Record<string, number> = {};
  const sockets: FakeSocket[] = [];

  beforeAll(async () => {
    ctx = await makeTestApp();
    platform = await setupPlatformAdmin(ctx);
    ({ admin: adminA, contractorId: A, adminUserId: adminAId } = await createContractorWithAdmin(platform, ctx, 'COMA', 'admin.coma@example.com'));
    ({ admin: adminB, contractorId: B } = await createContractorWithAdmin(platform, ctx, 'COMB', 'admin.comb@example.com'));
    ctx.app.comm.now = () => DAY;
    const fake: PushSendFn = async (sub, payload) => {
      const code = pushStatus[sub.endpoint];
      if (code && code >= 400) throw Object.assign(new Error(`Received unexpected response code ${code}`), { statusCode: code });
      pushes.push({ endpoint: sub.endpoint, payload });
      return { statusCode: 201 };
    };
    ctx.app.comm.pushSend = fake;
    ctx.app.comm.whatsapp.opts.loader = async () => fakeLibrary(sockets);
  });
  afterAll(async () => ctx?.close());

  async function outbox(email: string): Promise<number> {
    return (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM mail_outbox WHERE to_address = $1', [email])).rows[0]!.n;
  }

  async function addSub(userId: string, contractorId: string, endpoint: string) {
    await ctx.db.query(`INSERT INTO push_subscription (contractor_id, user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,'BPk-p256dh-key-xxxxxxxx','auth-key-1')`, [contractorId, userId, endpoint]);
  }

  // ───────────── WhatsApp click to chat (first: proves the library is never loaded) ─────────────

  it('default mode is click_to_chat; link and QR are correct; the library is not loaded', async () => {
    const m = await adminA.get('/api/admin/messaging');
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ whatsappMode: 'click_to_chat', riskWarning: LINKED_SESSION_WARNING, rateLimit: { minIntervalSeconds: 20, dailyLimit: 200 } });
    expect(m.json().riskWarning).toMatch(/unofficial.*terms.*banned.*session can drop.*separate number.*agreed.*slow rate/i);

    const r = await adminA.get(`/api/whatsapp/link?to=${encodeURIComponent('+974 5555-0199')}&text=${encodeURIComponent('WR 100001 & ready? نعم')}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.url).toBe(`https://wa.me/97455550199?text=${encodeURIComponent('WR 100001 & ready? نعم')}`);
    expect(body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect((await adminA.get('/api/whatsapp/link?to=abc&text=x')).statusCode).toBe(400);
    expect((await new Client(ctx.app).get('/api/whatsapp/link?to=55550199&text=x')).statusCode).toBe(401);
    expect(normalizeNumber('0097455550199')).toBe('97455550199');
    expect(normalizeNumber('55550199')).toBe('97455550199');

    // A WhatsApp notification in click-to-chat mode becomes an in-app item with the ready link.
    const tech = await addUser(ctx, A, { email: 'tech.wa@example.com', role: 'technician', notifyEmail: false, notifyPush: false, notifyWhatsapp: true, mobile: '+97455550111' });
    await notify(ctx.app, { contractorId: A, userIds: [tech], event: 'wr.assigned', title: 'WR 100002 assigned to you', url: '/wr/100002' });
    const list = await rows(ctx, tech, 'wr.assigned');
    const inApp = list.find((x) => x.channel === 'in_app')!;
    expect(inApp.data.whatsapp.url).toBe(`https://wa.me/97455550111?text=${encodeURIComponent('WR 100002 assigned to you\nhttps://sonu.example.test/wr/100002')}`);
    expect(list.find((x) => x.channel === 'whatsapp')!.status).toBe('skipped');
    expect(ctx.app.comm.whatsapp.loaderCalls).toBe(0);
    expect(sockets.length).toBe(0);
  });

  it('switching to linked_session needs acknowledgeRisk; the switch is audited', async () => {
    const no = await adminA.put('/api/admin/messaging', { whatsappMode: 'linked_session' });
    expect(no.statusCode).toBe(400);
    expect(no.json().error.code).toBe('risk_not_acknowledged');
    expect((await adminA.get('/api/admin/messaging')).json().whatsappMode).toBe('click_to_chat');
    expect((await adminA.put('/api/admin/messaging', { rateLimit: { minIntervalSeconds: 5 } })).statusCode).toBe(400); // below hard cap

    const yes = await adminA.put('/api/admin/messaging', { whatsappMode: 'linked_session', acknowledgeRisk: true });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().whatsappMode).toBe('linked_session');
    expect(yes.json().riskAcknowledgedAt).toBeTruthy();
    const audit = await ctx.db.query(`SELECT details FROM audit_log WHERE action = 'messaging.whatsapp_mode' AND contractor_id = $1`, [A]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ from: 'click_to_chat', to: 'linked_session' });
    // Other tenants unaffected
    expect((await adminB.get('/api/admin/messaging')).json().whatsappMode).toBe('click_to_chat');
  });

  it('linked driver (fake socket): QR → connected → consent + rate limit → disconnect wipes the session', async () => {
    const consenting = await addUser(ctx, A, { email: 'sup.wa@example.com', role: 'supervisor', notifyWhatsapp: true, mobile: '+97455550122' });
    await addUser(ctx, A, { email: 'nowa@example.com', role: 'supervisor', notifyWhatsapp: false, mobile: '+97455550133' });

    const start = await adminA.post('/api/admin/whatsapp/link/start');
    expect(start.statusCode).toBe(200);
    expect(start.json().state).toBe('qr_pending');
    expect(start.json().qrSvg).toMatch(/^<svg/);
    expect(new Date(start.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(ctx.app.comm.whatsapp.loaderCalls).toBe(1);

    const sock = sockets.at(-1)!;
    sock.user = { id: '97455550999:7@s.whatsapp.net' };
    sock.emit('creds.update', { me: { id: '97455550999:7@s.whatsapp.net' } });
    sock.emit('connection.update', { connection: 'open' });
    await ctx.app.comm.whatsapp.get(A)!.flush();

    const st = (await adminA.get('/api/admin/whatsapp/status')).json();
    expect(st).toMatchObject({ mode: 'linked_session', state: 'connected', available: true, linkedNumber: '+974••••0999', sentToday: 0, dailyLimit: 200, minIntervalSeconds: 20 });
    const ms = (await ctx.db.query('SELECT wa_session_secret_id FROM messaging_settings WHERE contractor_id = $1', [A])).rows[0];
    expect(ms.wa_session_secret_id).toBeTruthy();
    const raw = await ctx.db.query(`SELECT ciphertext::text AS c FROM secret WHERE id = $1`, [ms.wa_session_secret_id]);
    expect(raw.rows[0].c).not.toContain(SESSION_MARKER); // encrypted

    const wa = await getWhatsAppChannel(ctx.app, A);
    expect(wa.sendText).toBeTypeOf('function');
    await expect(wa.sendText!('+97455550133', 'hi')).rejects.toBeInstanceOf(WaConsentError);
    await expect(wa.sendText!('+97455550144', 'hi')).rejects.toBeInstanceOf(WaConsentError);
    expect(await wa.sendText!('+974 5555 0122', 'first')).toEqual({ messageId: 'msg-1' });
    await expect(wa.sendText!('+97455550122', 'too soon')).rejects.toBeInstanceOf(WaRateLimitedError);
    ctx.app.comm.now = () => new Date(DAY.getTime() + 21_000);
    expect(await wa.sendText!('+97455550122', 'second')).toEqual({ messageId: 'msg-2' });
    expect(sock.sent.map((s) => s.jid)).toEqual(['97455550122@s.whatsapp.net', '97455550122@s.whatsapp.net']);

    // Daily cap
    await adminA.put('/api/admin/messaging', { rateLimit: { dailyLimit: 2 } });
    ctx.app.comm.now = () => new Date(DAY.getTime() + 60_000);
    const err = await wa.sendText!('+97455550122', 'third').catch((e) => e);
    expect(err).toBeInstanceOf(WaRateLimitedError);
    expect(err.message).toMatch(/daily limit/);
    expect((await adminA.get('/api/admin/whatsapp/status')).json().sentToday).toBe(2);
    await adminA.put('/api/admin/messaging', { rateLimit: { dailyLimit: 200 } });

    // Notification through the linked session; rate-limited row waits without spending an attempt.
    ctx.app.comm.now = () => new Date(DAY.getTime() + 120_000);
    await notify(ctx.app, { contractorId: A, userIds: [consenting], event: 'wr.linked', title: 'WR 100003', channels: ['whatsapp'] });
    const sent = (await rows(ctx, consenting, 'wr.linked')).find((x) => x.channel === 'whatsapp')!;
    expect(sent.status).toBe('sent');
    expect(sent.data.via).toBe('linked_session');
    await notify(ctx.app, { contractorId: A, userIds: [consenting], event: 'wr.linked2', title: 'WR 100004', channels: ['whatsapp'] });
    const waiting = (await rows(ctx, consenting, 'wr.linked2')).find((x) => x.channel === 'whatsapp')!;
    expect(waiting.status).toBe('pending');
    expect(waiting.attempts).toBe(0);
    expect(new Date(waiting.next_attempt_at).getTime()).toBe(DAY.getTime() + 140_000);

    // Responses never contain the session
    const bodies = [(await adminA.get('/api/admin/whatsapp/status')).body, (await adminA.get('/api/admin/messaging')).body, (await adminA.get('/api/admin/audit?pageSize=500')).body];
    for (const b of bodies) {
      expect(b).not.toContain(SESSION_MARKER);
      expect(b).not.toContain('97455550999');
    }

    const d = await adminA.post('/api/admin/whatsapp/disconnect');
    expect(d.statusCode).toBe(200);
    expect(d.json().state).toBe('off');
    expect(sock.loggedOut).toBe(true);
    const after = (await ctx.db.query('SELECT wa_session_secret_id, wa_linked_number FROM messaging_settings WHERE contractor_id = $1', [A])).rows[0];
    expect(after).toEqual({ wa_session_secret_id: null, wa_linked_number: null });
    expect((await ctx.db.query('SELECT 1 FROM secret WHERE id = $1', [ms.wa_session_secret_id])).rowCount).toBe(0);
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'whatsapp.disconnect' AND contractor_id = $1`, [A])).rowCount).toBe(1);
  });

  it('falls back to click to chat when the linked session drops; logout by WhatsApp wipes the session', async () => {
    await adminA.post('/api/admin/whatsapp/link/start');
    const sock = sockets.at(-1)!;
    sock.user = { id: '97455550999@s.whatsapp.net' };
    sock.emit('connection.update', { connection: 'open' });
    expect((await getWhatsAppChannel(ctx.app, A)).sendText).toBeTypeOf('function');
    sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('Connection Lost'), { output: { statusCode: 428 } }) } });
    await ctx.app.comm.whatsapp.get(A)!.flush();
    const st = (await adminA.get('/api/admin/whatsapp/status')).json();
    expect(st.state).toBe('disconnected');
    expect(st.fallbackToClickToChat).toBe(true);
    const wa = await getWhatsAppChannel(ctx.app, A);
    expect(wa.sendText).toBeUndefined();
    expect(wa.buildLink('55550122', 'x')).toBe('https://wa.me/97455550122?text=x');

    const u = await addUser(ctx, A, { email: 'fallback.wa@example.com', role: 'foreman', notifyWhatsapp: true, mobile: '+97455550155', notifyEmail: false, notifyPush: false });
    await notify(ctx.app, { contractorId: A, userIds: [u], event: 'wr.fallback', title: 'WR 100005' });
    const list = await rows(ctx, u, 'wr.fallback');
    expect(list.find((x) => x.channel === 'in_app')!.data.whatsapp.url).toBe('https://wa.me/97455550155?text=WR%20100005');
    expect(list.find((x) => x.channel === 'whatsapp')!.data.via).toBe('fallback_click_to_chat');

    // Banned / logged out from the phone
    await adminA.post('/api/admin/whatsapp/link/start');
    const s2 = sockets.at(-1)!;
    s2.emit('connection.update', { connection: 'open' });
    await ctx.app.comm.whatsapp.get(A)!.flush();
    expect((await ctx.db.query('SELECT wa_session_secret_id FROM messaging_settings WHERE contractor_id = $1', [A])).rows[0].wa_session_secret_id).toBeTruthy();
    s2.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await ctx.app.comm.whatsapp.get(A)!.flush();
    expect((await adminA.get('/api/admin/whatsapp/status')).json().state).toBe('banned_or_logged_out');
    expect((await ctx.db.query('SELECT wa_session_secret_id FROM messaging_settings WHERE contractor_id = $1', [A])).rows[0].wa_session_secret_id).toBeNull();

    // link/start in click_to_chat mode is refused; B (click to chat) never got a session
    expect((await adminB.post('/api/admin/whatsapp/link/start')).statusCode).toBe(409);
    await adminA.put('/api/admin/messaging', { whatsappMode: 'click_to_chat' });
    expect((await adminA.get('/api/admin/whatsapp/status')).json().state).toBe('off');
  });

  it('linked session reports unavailable with the reason when the library cannot be loaded', async () => {
    const { WhatsAppManager } = await import('../src/comm/whatsapp/index.js');
    const m = new WhatsAppManager(ctx.db, ctx.app.log, { loader: async () => { throw new Error('The WhatsApp library "baileys" is not installed on this server (linked session unavailable).'); }, reconnect: false });
    expect(await m.availability()).toEqual({ available: false, reason: expect.stringMatching(/not installed/) });
  });

  // ───────────── Notifications ─────────────

  it('fans out per preference; push and e-mail sent at once', async () => {
    ctx.app.comm.now = () => DAY;
    const all = await addUser(ctx, A, { email: 'coord.all@example.com', role: 'coordinator' });
    const none = await addUser(ctx, A, { email: 'coord.none@example.com', role: 'coordinator', notifyEmail: false, notifyPush: false });
    await addSub(all, A, 'https://push.example.test/sub/all-1');
    const before = await outbox('coord.all@example.com');
    const res = await notify(ctx.app, { contractorId: A, roles: ['coordinator'], event: 'wr.not_owned', title: 'WR 100010 not owned', body: 'Owner needed', url: '/wr/100010' });
    expect(res.recipients).toBe(2);
    const a = await rows(ctx, all, 'wr.not_owned');
    expect(a.map((x) => [x.channel, x.status])).toEqual([['email', 'sent'], ['in_app', 'sent'], ['push', 'sent']]);
    expect((await rows(ctx, none, 'wr.not_owned')).map((x) => x.channel)).toEqual(['in_app']);
    expect(await outbox('coord.all@example.com')).toBe(before + 1);
    const p = pushes.find((x) => x.endpoint.endsWith('all-1'))!;
    expect(JSON.parse(p.payload)).toMatchObject({ title: 'WR 100010 not owned', url: '/wr/100010' });
    // Push off for the contractor → no push rows
    await adminA.put('/api/admin/messaging', { pushEnabled: false });
    await notify(ctx.app, { contractorId: A, userIds: [all], event: 'wr.pushoff', title: 'x' });
    expect((await rows(ctx, all, 'wr.pushoff')).map((x) => x.channel)).toEqual(['email', 'in_app']);
    await adminA.put('/api/admin/messaging', { pushEnabled: true });
  });

  it('quiet hours defer e-mail and push to the end of the quiet hours; in-app is immediate', async () => {
    const u = await addUser(ctx, A, { email: 'sleepy@example.com', role: 'supervisor', qs: '21:00', qe: '07:00' });
    await addSub(u, A, 'https://push.example.test/sub/sleepy');
    ctx.app.comm.now = () => NIGHT;
    const res = await notify(ctx.app, { contractorId: A, userIds: [u], event: 'wr.night', title: 'WR 100011' });
    expect(res.deferred).toBe(2);
    let list = await rows(ctx, u, 'wr.night');
    expect(list.find((x) => x.channel === 'in_app')!.status).toBe('sent');
    for (const ch of ['email', 'push']) {
      const r = list.find((x) => x.channel === ch)!;
      expect(r.status).toBe('pending');
      expect(new Date(r.next_attempt_at).toISOString()).toBe(MORNING_END.toISOString());
    }
    await dispatchPending(ctx.app);
    expect((await rows(ctx, u, 'wr.night')).filter((x) => x.status === 'pending')).toHaveLength(2);
    ctx.app.comm.now = () => new Date(MORNING_END.getTime() + 60_000);
    await dispatchPending(ctx.app);
    list = await rows(ctx, u, 'wr.night');
    expect(list.every((x) => x.status === 'sent')).toBe(true);
    ctx.app.comm.now = () => DAY;
  });

  it('a deadline breach always reaches the managers (opt-out and quiet hours ignored)', async () => {
    const mgr = await addUser(ctx, A, { email: 'manager.a@example.com', role: 'manager', notifyEmail: false, notifyPush: false, qs: '00:00', qe: '23:59' });
    const owner = await addUser(ctx, A, { email: 'owner.a@example.com', role: 'supervisor' });
    const mgrB = await addUser(ctx, B, { email: 'manager.b@example.com', role: 'manager' });
    const before = await outbox('manager.a@example.com');
    await notify(ctx.app, { contractorId: A, userIds: [owner], event: 'deadline.breach', title: 'WR 100012 breached', alwaysManagerOnBreach: true });
    const m = await rows(ctx, mgr, 'deadline.breach');
    expect(m.map((x) => [x.channel, x.status])).toEqual([['email', 'sent'], ['in_app', 'sent'], ['push', 'skipped']]);
    expect((await rows(ctx, owner, 'deadline.breach')).length).toBeGreaterThan(0);
    expect(await rows(ctx, mgrB, 'deadline.breach')).toHaveLength(0); // other tenant
    expect(await outbox('manager.a@example.com')).toBe(before + 1);
  });

  it('push 410 removes the subscription; a 500 is retried with back-off and a clean error', async () => {
    const u = await addUser(ctx, A, { email: 'gone@example.com', role: 'technician', notifyEmail: false });
    await addSub(u, A, 'https://push.example.test/sub/gone');
    pushStatus['https://push.example.test/sub/gone'] = 410;
    await notify(ctx.app, { contractorId: A, userIds: [u], event: 'wr.gone', title: 'x' });
    expect((await ctx.db.query('SELECT 1 FROM push_subscription WHERE endpoint = $1', ['https://push.example.test/sub/gone'])).rowCount).toBe(0);
    expect((await rows(ctx, u, 'wr.gone')).find((x) => x.channel === 'push')!.status).toBe('skipped');

    await addSub(u, A, 'https://push.example.test/sub/flaky');
    pushStatus['https://push.example.test/sub/flaky'] = 500;
    await notify(ctx.app, { contractorId: A, userIds: [u], event: 'wr.flaky', title: 'x' });
    const r = (await rows(ctx, u, 'wr.flaky')).find((x) => x.channel === 'push')!;
    expect(r).toMatchObject({ status: 'pending', attempts: 1, error: 'push service answered HTTP 500' });
    expect(new Date(r.next_attempt_at).getTime()).toBe(DAY.getTime() + 60_000);
    for (let i = 1; i <= 6; i++) {
      ctx.app.comm.now = () => new Date(DAY.getTime() + i * 24 * 3600_000);
      await dispatchPending(ctx.app);
    }
    expect((await rows(ctx, u, 'wr.flaky')).find((x) => x.channel === 'push')!).toMatchObject({ status: 'failed', attempts: 5 });
    ctx.app.comm.now = () => DAY;
  });

  it('push routes: public key, subscribe, test, unsubscribe', async () => {
    const pk = await adminA.get('/api/push/public-key');
    expect(pk.statusCode).toBe(200);
    expect(pk.json().publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await adminA.post('/api/push/subscribe', { endpoint: 'http://insecure.example/x', keys: { p256dh: 'BPk-p256dh-key-xxxxxxxx', auth: 'auth-key' } })).statusCode).toBe(400);
    const sub = { endpoint: 'https://push.example.test/sub/admin-a', expirationTime: null, keys: { p256dh: 'BPk-p256dh-key-xxxxxxxx', auth: 'auth-key' } };
    expect((await adminA.post('/api/push/subscribe', sub)).statusCode).toBe(200);
    const t = await adminA.post('/api/push/test');
    expect(t.json()).toMatchObject({ devices: 1, sent: 1 });
    expect(pushes.at(-1)!.endpoint).toBe(sub.endpoint);
    // B cannot remove A's device
    expect((await adminB.post('/api/push/unsubscribe', { endpoint: sub.endpoint })).json().removed).toBe(0);
    expect((await adminA.post('/api/push/unsubscribe', { endpoint: sub.endpoint })).json().removed).toBe(1);
    expect((await adminA.post('/api/push/test')).json()).toMatchObject({ devices: 0, sent: 0 });
  });

  it('list with unread count and paging; read / read-all; tenant isolation', async () => {
    for (let i = 0; i < 3; i++) await notify(ctx.app, { contractorId: A, userIds: [adminAId], event: 'page.test', title: `P${i}`, channels: ['in_app'] });
    await adminA.post('/api/notifications/read-all');
    for (let i = 0; i < 3; i++) await notify(ctx.app, { contractorId: A, userIds: [adminAId], event: 'page.test', title: `Q${i}`, channels: ['in_app'] });
    const p1 = (await adminA.get('/api/notifications?limit=2')).json();
    expect(p1.unread).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBeGreaterThanOrEqual(6);
    const p2 = (await adminA.get('/api/notifications?limit=2&offset=2')).json();
    expect(p2.items.map((x: any) => x.id)).not.toContain(p1.items[0].id);
    const unread = (await adminA.get('/api/notifications?unread=1&limit=50')).json();
    expect(unread.items).toHaveLength(3);
    expect(unread.total).toBe(3);

    // B sees none of A's and cannot mark them read
    const bList = (await adminB.get('/api/notifications')).json();
    expect(bList.items.find((x: any) => x.id === p1.items[0].id)).toBeUndefined();
    expect((await adminB.post(`/api/notifications/${p1.items[0].id}/read`)).statusCode).toBe(404);
    expect((await adminA.post(`/api/notifications/${p1.items[0].id}/read`)).statusCode).toBe(200);
    expect((await adminA.get('/api/notifications')).json().unread).toBe(2);
    expect((await adminA.post('/api/notifications/read-all')).json().marked).toBe(2);
    // Platform admin cannot read or change a contractor's messaging settings without choosing it; B cannot ask for A
    expect((await platform.get('/api/admin/messaging')).statusCode).toBe(400);
    expect((await adminB.get(`/api/admin/messaging?contractorId=${A}`)).statusCode).toBe(403);
    expect((await adminB.get(`/api/admin/whatsapp/status?contractorId=${A}`)).statusCode).toBe(403);
    expect((await new Client(ctx.app).get('/api/notifications')).statusCode).toBe(401);
  });
});
