#!/usr/bin/env node
/**
 * SONU step-1 end-to-end smoke test (plain Node 22+; exceljs and pg are taken from server/node_modules).
 *
 *   node scripts/e2e-smoke.mjs [--log <dev.log>] [--outbox-db <postgres url>] [--out <logins.json>]
 *   env SONU_URL (default http://localhost:3000), SONU_SETUP_CODE (optional, else read from the log)
 *
 * Invitation tokens come from mail_outbox (--outbox-db) or from the server's dev log (--log).
 * Test passwords are generated at run time, written to the logins file and never printed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'server', 'package.json'));

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = (process.env.SONU_URL || 'http://localhost:3000').replace(/\/$/, '');
const LOG_FILE = arg('--log');
const OUTBOX_DB = arg('--outbox-db');
const LOGINS_FILE = arg('--out') || path.resolve(process.cwd(), 'e2e-logins.json');
const RUN = crypto.randomBytes(3).toString('hex');

// ───────────────────────────── tiny HTTP client with cookie jar ─────────────────────────────
class Client {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
  }
  async req(method, url, { json, form, raw = false } = {}) {
    const headers = { 'X-Requested-With': 'sonu' };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (!v || /max-age=0/i.test(sc)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    if (raw) return { status: res.status, res, buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
  get = (u, o) => this.req('GET', u, o);
  post = (u, json, o) => this.req('POST', u, { json: json ?? {}, ...o });
  put = (u, json) => this.req('PUT', u, { json });
  patch = (u, json) => this.req('PATCH', u, { json });
}

// ───────────────────────────── step runner ─────────────────────────────
let failures = 0;
let stepNo = 0;
async function step(name, fn) {
  stepNo++;
  const label = `${String(stepNo).padStart(2, '0')} ${name}`;
  try {
    const extra = await fn();
    console.log(`PASS  ${label}${extra ? '  - ' + extra : ''}`);
    return true;
  } catch (e) {
    failures++;
    console.log(`FAIL  ${label}\n        ${String(e.message ?? e).split('\n').join('\n        ')}`);
    return false;
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
function expectStatus(r, status, what) {
  if (r.status !== status) {
    throw new Error(`${what}: expected HTTP ${status}, got ${r.status} ${typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data)?.slice(0, 600)}`);
  }
  return r.data;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o);

// ───────────────────────────── helpers ─────────────────────────────
const genPassword = () => `Aa1-${crypto.randomBytes(9).toString('base64url')}`;
const logins = {};
function remember(key, email, password, role) {
  logins[key] = { email, password, role, baseUrl: BASE };
  fs.mkdirSync(path.dirname(LOGINS_FILE), { recursive: true });
  fs.writeFileSync(LOGINS_FILE, JSON.stringify(logins, null, 2));
}

function readLogLines() {
  if (!LOG_FILE) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
}
function setupCodeFromLog() {
  let code = null;
  for (const line of readLogLines()) {
    const m = line.match(/setup code:\\n\\n\s+([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (m) code = m[1];
  }
  return code;
}
const tokenFromText = (text) => {
  const m = String(text).match(/accept-invite\?token=([A-Za-z0-9_%.\-]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};
let pgClient = null;
async function inviteToken(email) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (OUTBOX_DB) {
      if (!pgClient) {
        const { Client: PgClient } = require('pg');
        pgClient = new PgClient({ connectionString: OUTBOX_DB });
        await pgClient.connect();
      }
      const r = await pgClient.query('SELECT body_text FROM mail_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC', [email]);
      for (const row of r.rows) {
        const t = tokenFromText(row.body_text);
        if (t) return t;
      }
    } else if (LOG_FILE) {
      const lines = readLogLines();
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (o?.mail?.to && String(o.mail.to).toLowerCase().includes(email.toLowerCase())) {
          const t = tokenFromText(o.msg);
          if (t) return t;
        }
      }
    } else throw new Error('Neither --outbox-db nor --log was given: cannot read invitation tokens.');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No invitation link found for ${email}`);
}
async function acceptInvite(email, password, fullName) {
  const token = await inviteToken(email);
  const c = new Client(email);
  const chk = expectStatus(await c.post('/api/auth/invitation/check', { token }), 200, 'invitation check');
  ok(chk.email.toLowerCase() === email.toLowerCase(), 'invitation check returned another e-mail');
  const me = expectStatus(await c.post('/api/auth/accept-invite', { token, password, fullName }), 200, 'accept-invite');
  ok(me.user?.email === email, 'accept-invite did not sign in the right user');
  const again = await new Client('x').post('/api/auth/accept-invite', { token, password });
  ok(again.status === 410, `invitation token re-use should give 410, got ${again.status}`);
  return c;
}

// tiny valid PNG (4x4)
function makePng() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 4, h = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < w; x++) rows.push(Buffer.from([200, 30, 30]));
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const fileForm = (filePath, fields = {}, name = path.basename(filePath), field = 'file') => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append(field, new Blob([fs.readFileSync(filePath)]), name);
  return f;
};

// ───────────────────────────── the flow ─────────────────────────────
const platform = new Client('platform');
let platformEmail, platformPw, adminEmail, adminPw, contractor, admin;
const users = {};
const teams = {};
let assigned = null;
const dateNotes = [];

console.log(`SONU e2e smoke test against ${BASE} (run ${RUN})`);

let resumed = false;
await step('server reachable; first-run setup with the one-time code', async () => {
  const d = expectStatus(await platform.get('/api/setup'), 200, 'GET /api/setup');
  if (!d.needed) {
    // Re-run on a database that already has the platform admin: reuse the login from the logins file.
    const prev = fs.existsSync(LOGINS_FILE) ? JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8')) : {};
    ok(prev.platform_admin, 'setup is already done and no platform_admin login is in the logins file (fresh database needed)');
    platformEmail = prev.platform_admin.email;
    platformPw = prev.platform_admin.password;
    Object.assign(logins, { platform_admin: prev.platform_admin });
    resumed = true;
    return 'setup already done; reusing the platform admin from the logins file';
  }
  const code = process.env.SONU_SETUP_CODE || setupCodeFromLog();
  ok(code, 'Setup code not found: pass --log <dev.log> or env SONU_SETUP_CODE');
  platformEmail = `platform-${RUN}@example.com`;
  platformPw = genPassword();
  const r = expectStatus(await platform.post('/api/setup', { code, email: platformEmail, fullName: 'Test Platform Admin', password: platformPw }), 201, 'POST /api/setup');
  ok(r.user.role === 'platform_admin', 'setup user is not platform_admin');
  remember('platform_admin', platformEmail, platformPw, 'platform_admin');
});

await step('platform admin logs out and in again', async () => {
  expectStatus(await platform.post('/api/auth/logout'), 200, 'logout');
  expectStatus(await platform.get('/api/auth/me'), 401, 'me after logout');
  expectStatus(await platform.post('/api/auth/login', { email: platformEmail, password: platformPw + 'x' }), 401, 'login with wrong password');
  const d = expectStatus(await platform.post('/api/auth/login', { email: platformEmail, password: platformPw }), 200, 'login');
  ok(d.user.role === 'platform_admin', 'login did not return the platform admin');
});

await step('create contractor "Test Contractor W.L.L." (TST)', async () => {
  adminEmail = 'admin@example.com';
  const d = expectStatus(
    await platform.post('/api/admin/contractors', {
      code: 'TST',
      name: 'Test Contractor W.L.L.',
      admin: { fullName: 'Test Contractor Admin', email: adminEmail },
    }),
    201,
    'POST /api/admin/contractors',
  );
  contractor = d.contractor;
  ok(contractor.code === 'TST', 'contractor code');
  ok(d.invitation && !d.invitation.error, `invitation e-mail not sent: ${JSON.stringify(d.invitation)}`);
});

await step('contractor admin accepts invitation and logs in', async () => {
  adminPw = genPassword();
  admin = await acceptInvite(adminEmail, adminPw, 'Test Contractor Admin');
  remember('contractor_admin', adminEmail, adminPw, 'contractor_admin');
  await admin.post('/api/auth/logout');
  const d = expectStatus(await admin.post('/api/auth/login', { email: adminEmail, password: adminPw }), 200, 'admin login');
  ok(d.user.role === 'contractor_admin' && d.contractor?.code === 'TST', 'admin login view wrong');
});

await step('create work teams for the three zones', async () => {
  for (const n of [1, 2, 3]) {
    teams[`Zone-${n}`] = expectStatus(await admin.post('/api/admin/work-teams', { code: `TEST-WT-${n}`, name: `Test team zone ${n}`, zone: `Zone-${n}` }), 201, `create team ${n}`);
  }
  const l = expectStatus(await admin.get('/api/admin/work-teams'), 200, 'list teams');
  ok(l.items.length === 3, `expected 3 teams, got ${l.items.length}`);
  expectStatus(await admin.post('/api/admin/work-teams', { code: 'test-wt-1' }), 409, 'duplicate team code');
});

const FORM_USERS = [
  { key: 'supervisor', role: 'supervisor', name: 'Test Supervisor', team: 'Zone-2', discipline: 'HVAC' },
  { key: 'technician', role: 'technician', name: 'Test Technician', team: 'Zone-2', discipline: 'HVAC' },
  { key: 'foreman', role: 'foreman', name: 'Test Foreman', team: 'Zone-2' },
  { key: 'coordinator', role: 'coordinator', name: 'Test Coordinator' },
  { key: 'manager', role: 'manager', name: 'Test Manager' },
];

await step('invite users by form (supervisor, technician, foreman, coordinator, manager)', async () => {
  for (const u of FORM_USERS) {
    u.email = `${u.key}-${RUN}@example.com`;
    const body = { email: u.email, fullName: u.name, role: u.role, mobile: '+97455550' + String(100 + FORM_USERS.indexOf(u)) };
    if (u.team) body.workTeamIds = [teams[u.team].id];
    if (u.discipline) body.discipline = u.discipline;
    const d = expectStatus(await admin.post('/api/admin/users', body), 201, `invite ${u.key}`);
    ok(d.user.status === 'invited', `${u.key} should be invited`);
    ok(!d.invitation?.error, `invitation mail for ${u.key}: ${JSON.stringify(d.invitation)}`);
    u.id = d.user.id;
    users[u.key] = u;
  }
  expectStatus(await admin.post('/api/admin/users', { email: FORM_USERS[0].email, fullName: 'Dup User', role: 'technician' }), 409, 'duplicate e-mail');
});

await step('invited users accept their invitations and log in', async () => {
  for (const u of FORM_USERS) {
    u.password = genPassword();
    u.client = await acceptInvite(u.email, u.password, u.name);
    remember(u.key, u.email, u.password, u.role);
    const me = expectStatus(await u.client.get('/api/auth/me'), 200, `me ${u.key}`);
    ok(me.user.role === u.role, `${u.key} role is ${me.user.role}`);
  }
  expectStatus(await users.coordinator.client.post('/api/admin/work-teams', { code: 'NOPE' }), 403, 'coordinator creating a team');
});

await step('bulk import users from template (2 rows + EXAMPLE row): preview, then confirm', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(root, 'assets', 'SONU-import-users.xlsx'));
  const ws = wb.getWorksheet('Users');
  ok(ws, 'Users sheet missing in the template');
  const hdr = {};
  ws.getRow(1).eachCell((cell, col) => (hdr[String(cell.value).replace(/\*/g, '').trim()] = col));
  const bulkEmails = [`bulk-tech-${RUN}@example.com`, `bulk-foreman-${RUN}@example.com`];
  const rows = [
    { 'Contractor Code': 'TST', 'Full Name': 'Bulk Technician One', Email: bulkEmails[0], Mobile: '+97455550201', Role: 'Technician', 'Work Teams': 'TEST-WT-1', Discipline: 'Civil', Language: 'English', 'Notify by Email': 'Yes', Status: 'Active' },
    { 'Contractor Code': 'TST', 'Full Name': 'Bulk Foreman Two', Email: bulkEmails[1], Mobile: '+97455550202', Role: 'Foreman', 'Work Teams': 'TEST-WT-3', Discipline: 'Electrical', Language: 'English', 'Notify by Email': 'Yes', Status: 'Active' },
  ];
  rows.forEach((r, i) => {
    const row = ws.getRow(3 + i);
    for (const [k, v] of Object.entries(r)) row.getCell(hdr[k]).value = v;
  });
  const tmp = path.join(path.dirname(LOGINS_FILE), `e2e-users-${RUN}.xlsx`);
  await wb.xlsx.writeFile(tmp);
  const prev = expectStatus(await admin.req('POST', '/api/admin/bulk-import/preview', { form: fileForm(tmp, { kind: 'users' }, 'SONU-import-users.xlsx') }), 201, 'bulk preview');
  const c = prev.counts;
  ok(c.add === 2 && c.update === 0 && c.problem === 0, `preview counts expected add 2 / update 0 / problem 0, got ${JSON.stringify(c)}; ${JSON.stringify(prev.rows.map((r) => r.problems))}`);
  ok(c.skippedExamples === 1, `expected 1 EXAMPLE row skipped, got ${c.skippedExamples}`);
  const done = expectStatus(await admin.post(`/api/admin/bulk-import/confirm/${prev.id}`), 200, 'bulk confirm');
  ok(done.status === 'confirmed' && done.result.added === 2 && done.result.rejected === 0, `confirm result ${JSON.stringify(done.result)}`);
  ok(done.invitationsSent === 2, `invitationsSent ${done.invitationsSent} ${JSON.stringify(done.invitationErrors)}`);
  expectStatus(await admin.post(`/api/admin/bulk-import/confirm/${prev.id}`), 409, 'second confirm');
  const list = expectStatus(await admin.get('/api/admin/users?pageSize=200'), 200, 'list users');
  for (const e of bulkEmails) ok(list.items.some((u) => u.email === e), `${e} not in user list`);
  fs.rmSync(tmp, { force: true });
  return `added 2, example rows skipped ${c.skippedExamples}`;
});

const coord = () => users.coordinator.client;

await step('coordinator uploads pending-work-requests.xlsx and review-approved-estimations.xlsx', async () => {
  const a = expectStatus(await coord().req('POST', '/api/imports', { form: fileForm(path.join(root, 'fixtures', 'pending-work-requests.xlsx')) }), 201, 'import pending WRs');
  ok(a.ok && a.listKey === 'pending_work_requests', `listKey ${a.listKey}`);
  ok(a.rowsRead === 60 && a.new === 60, `expected 60 rows read / 60 new, got read ${a.rowsRead} new ${a.new}`);
  const b = expectStatus(await coord().req('POST', '/api/imports', { form: fileForm(path.join(root, 'fixtures', 'review-approved-estimations.xlsx')) }), 201, 'import estimations');
  ok(b.ok, 'estimations import not ok');
  return `pending: ${a.rowsRead} rows, ${a.new} new; estimations: ${b.rowsRead} rows (${b.listKey})`;
});

await step('coordinator uploads tracker-master.xlsx (contractor statuses) and confirms', async () => {
  const up = expectStatus(await coord().req('POST', '/api/imports/tracker', { form: fileForm(path.join(root, 'fixtures', 'tracker-master.xlsx')) }), 201, 'tracker upload');
  ok(up.matched === 60 && !up.unknownWrCodes.length, `tracker: matched ${up.matched}, unknown WR codes ${JSON.stringify(up.unknownWrCodes)}`);
  const unk = (up.unknownStatuses ?? []).length;
  const map = {};
  for (const u of up.unknownStatuses ?? []) if (u.suggested) map[u.value] = u.suggested;
  const c = expectStatus(await coord().post(`/api/imports/tracker/confirm/${up.id}`, { statusMap: map }), 200, 'tracker confirm');
  ok(c.written > 0, `tracker confirm wrote ${c.written}`);
  return `matched ${up.matched}, written ${c.written}, unknown statuses ${unk}`;
});

await step('dashboard status x discipline / status x zone equal expected-counts.json (date-independent parts only)', async () => {
  const exp = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'expected-counts.json'), 'utf8'));
  const dash = expectStatus(await coord().get('/api/dashboard'), 200, 'dashboard');
  const probs = [];
  if (dash.totalOutstanding !== exp.totalOutstanding) probs.push(`totalOutstanding ${dash.totalOutstanding} != ${exp.totalOutstanding}`);
  const cmp = (name, got, want) => {
    if (!sameJson(sortKeys(got), sortKeys(want))) probs.push(`${name} differs
  got:  ${JSON.stringify(sortKeys(got))}
  want: ${JSON.stringify(sortKeys(want))}`);
  };
  const nz = (m) => Object.fromEntries(Object.entries(m ?? {}).map(([r, cols]) => [r, Object.fromEntries(Object.entries(cols).filter(([, n]) => n))]).filter(([, cols]) => Object.keys(cols).length));
  cmp('dashboard byDiscipline (status x discipline)', nz(dash.byDiscipline?.cells), exp.statusByDiscipline);
  cmp('dashboard byZone (status x zone)', nz(dash.byZone?.cells), exp.statusByZone);
  if (exp.statusByFacility && dash.byFacility?.cells) cmp('dashboard byFacility (status x facility)', nz(dash.byFacility.cells), exp.statusByFacility);
  dateNotes.push(
    'COMPARED (independent of today): totalOutstanding, status x discipline, status x zone (and status x facility) matrices from /api/dashboard.',
    'NOT COMPARED (depend on SONU_TODAY=2026-11-09, server was started without it): breached, backlogKpi, averageDaysSinceAssigned, ageBuckets, kpiSplit, tdSplit, rfeStatus, rfeTimeFrameSplit, byYear.',
  );
  ok(!probs.length, probs.join('\n'));
  return 'date-independent comparisons only (see notes at the end)';
});

await step('renamed-column file is refused with 422 naming the caption; nothing changes', async () => {
  const snap = async () => {
    const l = expectStatus(await coord().get('/api/work-requests?pageSize=2000&includeGone=1'), 200, 'WR list');
    return { total: l.total, s: JSON.stringify(l.items.map((w) => [w.wrCode, w.wrStatus, w.targetDate, w.estimatedTotalCost, w.goneAt])) };
  };
  const before = await snap();
  const r = await coord().req('POST', '/api/imports', { form: fileForm(path.join(root, 'fixtures', 'pending-work-requests-renamed-column.xlsx')) });
  expectStatus(r, 422, 'renamed column import');
  const e = r.data?.error;
  ok(e?.code === 'missing_caption', `error code ${e?.code}`);
  ok(/Agreed Target Date/.test(JSON.stringify(e)), `error does not name "Agreed Target Date": ${JSON.stringify(e).slice(0, 300)}`);
  ok(e.details?.missingCaptions?.some((c) => /Agreed Target Date/i.test(c)), `details.missingCaptions ${JSON.stringify(e.details?.missingCaptions)}`);
  const after = await snap();
  ok(before.s === after.s && before.total === after.total, 'work requests changed after the refused file');
  const hist = expectStatus(await coord().get('/api/imports?limit=5'), 200, 'import history');
  ok(hist.items[0]?.result === 'failed', `latest batch should be failed, got ${hist.items[0]?.result}`);
});

await step('changed file raises exactly the events of expected-events.json', async () => {
  const exp = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'expected-events.json'), 'utf8'));
  const beforeList = expectStatus(await coord().get('/api/work-requests?pageSize=2000&includeGone=1'), 200, 'WR list before');
  const existed = new Set(beforeList.items.map((w) => w.wrCode));
  const r = expectStatus(await coord().req('POST', '/api/imports', { form: fileForm(path.join(root, 'fixtures', 'pending-work-requests-changed.xlsx')) }), 201, 'import changed');
  const keys = [...new Set(exp.events.map((e) => e.key))];
  const got = [];
  for (const k of keys) {
    const d = expectStatus(await coord().get(`/api/work-requests/${k}`), 200, `WR ${k}`);
    let skippedFirstSeen = !existed.has(k); // the first wr.seen of a WR that was already known belongs to the first import
    for (const t of (d.timeline ?? []).filter((x) => x.kind === 'event').sort((a, b) => a.at.localeCompare(b.at))) {
      if (!/^wr\.(seen|changed|stage_changed|gone)$/.test(t.type)) continue; // other events (e.g. wr.tracker_loaded) are not part of the diff
      if (t.type === 'wr.seen' && !skippedFirstSeen) {
        skippedFirstSeen = true;
        continue;
      }
      const f = t.payload?.changes;
      got.push({ type: t.type, key: k, fields: Array.isArray(f) ? f.map((x) => x?.field ?? x) : undefined });
    }
  }
  const norm = (arr) => arr.map((e) => `${e.type}:${e.key}${e.fields?.length ? ':' + [...e.fields].sort().join(',') : ''}`).sort();
  const want = norm(exp.events);
  const have = norm(got);
  const missing = want.filter((x) => !have.includes(x));
  const extra = have.filter((x) => !want.includes(x));
  ok(!missing.length && !extra.length, `event mismatch\n  missing: ${JSON.stringify(missing)}\n  extra (timeline of those WRs): ${JSON.stringify(extra)}\n  import said: new ${r.new} changed ${r.changed} gone ${r.gone} events ${r.events}`);
  return `import: new ${r.new}, changed ${r.changed}, gone ${r.gone}, events ${r.events}; ${want.length} expected events matched`;
});

await step('supervisor takes ownership of a Zone-2 WR and assigns it to the technician', async () => {
  const sup = users.supervisor.client;
  const l = expectStatus(await sup.get('/api/work-requests?zone=Zone-2&pageSize=200'), 200, 'supervisor WR list');
  ok(l.items.length > 0, 'supervisor sees no Zone-2 WR (work team code mismatch?)');
  const wr = l.items.find((w) => !w.goneAt && !w.internal?.ownerId) ?? l.items[0];
  const p = expectStatus(await sup.patch(`/api/work-requests/${wr.wrCode}`, { takeOwnership: true }), 200, 'take ownership');
  ok(p.internal.ownerId === users.supervisor.id, 'owner is not the supervisor');
  const job = expectStatus(await sup.post(`/api/work-requests/${wr.wrCode}/assignments`, { assigneeId: users.technician.id, note: 'e2e smoke job' }), 201, 'assign technician');
  assigned = { wrCode: wr.wrCode, jobId: job.id };
  return `WR ${wr.wrCode}, job ${job.id}`;
});

await step('technician sees the job, starts it, posts an update with a PNG, marks it done', async () => {
  ok(assigned, 'no job was assigned in the previous step');
  const t = users.technician.client;
  const mj = expectStatus(await t.get('/api/my-jobs'), 200, 'my-jobs');
  ok([...(mj.todayJobs ?? []), ...(mj.open ?? [])].some((j) => j.id === assigned.jobId), 'assigned job not in /api/my-jobs');
  const s = expectStatus(await t.post(`/api/jobs/${assigned.jobId}/start`), 200, 'start');
  ok(JSON.stringify(s).includes('started'), `start response ${JSON.stringify(s).slice(0, 200)}`);
  const f = new FormData();
  f.append('note', 'Checked the unit, photo attached (e2e).');
  f.append('photos', new Blob([makePng()], { type: 'image/png' }), 'proof.png');
  const u = expectStatus(await t.req('POST', `/api/jobs/${assigned.jobId}/updates`, { form: f }), 201, 'post update');
  ok(u.attachments?.length === 1, `attachments ${JSON.stringify(u.attachments)}`);
  const att = await t.req('GET', `/api/attachments/${u.attachments[0]?.id ?? u.attachments[0]}`, { raw: true });
  ok(att.status === 200 && att.buf.subarray(1, 4).toString() === 'PNG', `attachment download status ${att.status}`);
  expectStatus(await t.post(`/api/jobs/${assigned.jobId}/done`, { note: 'Work finished (e2e).' }), 200, 'done');
  const j = expectStatus(await t.get(`/api/jobs/${assigned.jobId}`), 200, 'job');
  ok(j.status === 'done', `job status ${j.status}`);
});

await step('notifications: technician has job.assigned, supervisor has job.done', async () => {
  const tn = expectStatus(await users.technician.client.get('/api/notifications'), 200, 'tech notifications');
  ok(tn.items.some((n) => n.event === 'job.assigned'), `technician events: ${tn.items.map((n) => n.event)}`);
  const sn = expectStatus(await users.supervisor.client.get('/api/notifications'), 200, 'supervisor notifications');
  ok(sn.items.some((n) => n.event === 'job.done'), `supervisor events: ${sn.items.map((n) => n.event)}`);
});

await step('GET /api/exports/master.xlsx returns an xlsx', async () => {
  const r = await coord().req('GET', '/api/exports/master.xlsx', { raw: true });
  ok(r.status === 200, `status ${r.status} ${r.buf.toString().slice(0, 300)}`);
  ok(r.buf.subarray(0, 2).toString('latin1') === 'PK', 'response is not a zip/xlsx');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  ok(wb.worksheets.length > 0, 'workbook has no sheets');
  return `${r.buf.length} bytes, sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`;
});

await step('mail settings: SMTP password is write-only (never returned)', async () => {
  const secret = 'Smtp-' + crypto.randomBytes(8).toString('hex') + '-9';
  const put = await admin.put('/api/admin/mail', { driver: 'smtp', fromAddress: 'noreply@example.com', fromName: 'SONU Test', smtpHost: 'smtp.example.invalid', smtpPort: 587, smtpUser: 'smtp-user@example.com', password: secret });
  expectStatus(put, 200, 'PUT mail');
  ok(!JSON.stringify(put.data).includes(secret), 'password leaked in PUT response');
  const get = await admin.get('/api/admin/mail');
  expectStatus(get, 200, 'GET mail');
  ok(!JSON.stringify(get.data).includes(secret), 'password leaked in GET response');
  ok(get.data.hasPassword === true, 'hasPassword should be true');
  const back = await admin.put('/api/admin/mail', { driver: 'log' });
  expectStatus(back, 200, 'PUT mail back to log driver');
  ok(!JSON.stringify(back.data).includes(secret), 'password leaked after switching driver');
});

if (pgClient) await pgClient.end().catch(() => {});
console.log('');
for (const n of dateNotes) console.log('note: ' + n);
if (assigned) console.log(`Assigned job: WR code ${assigned.wrCode} (job ${assigned.jobId})`);
console.log(`Logins written to ${LOGINS_FILE} (passwords not printed)`);
console.log(failures ? `RESULT: ${failures} step(s) FAILED` : 'RESULT: all steps PASSED');
process.exit(failures ? 1 : 0);
