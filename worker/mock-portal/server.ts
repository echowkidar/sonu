/**
 * LOCAL MOCK of the parts of the Marafiq portal (ARCHIBUS Web Central) the worker touches.
 * Fictional data and credentials only. Never point the worker's tests at anything else.
 *
 * Imitates: login page (Project / Username / Password), allow-listed list views with Show / XLS /
 * paging, tabbed views whose grid is a sub-view in a frame, the DWR rule channel, export files.
 * Traps: Save / Delete / Approve / Issue / Complete / Submit buttons on every page, a generic-SQL
 * rule call fired by every page on load (as the real pages do), and a non-allow-listed view.
 * Every trap hit is recorded at /__trap-log. Sign-in attempts and more are counted at /__stats.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FORBIDDEN_VIEW, MOCK_VIEWS, type MockView } from './views.js';
import { findFixture, generateXlsx } from './xlsx.js';

export interface MockCredentials {
  project: string;
  username: string;
  password: string;
}

export interface MockOptions {
  credentials: MockCredentials;
  port?: number;
  host?: string;
  /** The first N sign-in POSTs answer "Internal error" whatever the credentials. */
  internalErrorFirstN?: number;
  /** A session ends after K top-level view page loads; the next view load is sent to the login page. */
  sessionExpiresAfterPageLoads?: number;
  /** Account locks after this many failed sign-ins (default 3). */
  lockAfterFailures?: number;
  /** List keys whose page has no XLS button. */
  listsWithoutXls?: string[];
  /** Serve list exports from this folder when a matching fixture exists. */
  fixturesDir?: string;
}

export interface TrapHit {
  at: string;
  what: string;
  method: string;
  path: string;
}

export interface MockStats {
  signInAttempts: number;
  failedSignIns: number;
  successfulSignIns: number;
  locked: boolean;
  pageLoads: number;
  downloads: number;
  dwrRules: Record<string, number>;
  userAgents: string[];
  requests: { method: string; path: string }[];
}

export interface MockPortal {
  origin: string;
  baseUrl: string;
  stats(): MockStats;
  trapLog(): TrapHit[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ALLOWED_RULES = new Set(['AbCommonResources-getDataRecords', 'AbSystemAdministration-generateGridXLSReport']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function parseDwr(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

function dec(s: string | undefined): string {
  if (!s) return '';
  const v = s.replace(/^(string|number):/, '');
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function loginPage(projects: string[], error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ARCHIBUS Sign In (mock)</title></head><body>
<h1>Sign In (mock portal)</h1>
<form method="post" action="/archibus/login.axvw">
  <p><label for="project">Project</label> <select id="project" name="project">${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select></p>
  <p><label for="username">Username</label> <input id="username" name="username" autocomplete="off"></p>
  <p><label for="password">Password</label> <input id="password" name="password" type="password"></p>
  <p><input type="submit" value="Sign In"></p>
  ${error ? `<div role="alert" class="loginError">${esc(error)}</div>` : ''}
</form></body></html>`;
}

const TRAP_BUTTONS = ['Save', 'Delete', 'Approve', 'Issue', 'Complete', 'Submit'];

function trapPanel(): string {
  return `<div class="trap-panel">${TRAP_BUTTONS.map((b) => `<input type="button" value="${b}" data-trap="${b.toLowerCase()}">`).join(' ')}</div>`;
}

const PAGE_SCRIPT_COMMON = `
function dwr(view, rule, extra) {
  var lines = ['callCount=1', 'page=/archibus/' + view, 'httpSessionId=', 'scriptSessionId=MOCK',
    'c0-scriptName=workflow', 'c0-methodName=runWorkflowRule', 'c0-id=0',
    'c0-param0=string:' + encodeURIComponent(rule), 'c0-e1=string:' + encodeURIComponent(view),
    'c0-param1=Object_Object:{viewName:reference:c0-e1}'];
  if (extra) lines.push(extra);
  lines.push('batchId=1');
  return fetch('/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: lines.join('\\n') })
    .then(function (r) { return r.json(); });
}
document.querySelectorAll('[data-trap]').forEach(function (b) {
  b.addEventListener('click', function () {
    fetch('/archibus/__trap/' + b.getAttribute('data-trap'), { method: 'POST' }).catch(function () {});
    dwr(VIEW, 'AbCommonResources-saveRecord', 'c0-e2=string:' + b.getAttribute('data-trap')).catch(function () {});
  });
});
// Like the real portal pages: SQL built in the browser and sent to the generic rule on load.
dwr(VIEW, 'AbCommonResources-executeCustomSQL', 'c0-e2=string:' + encodeURIComponent("UPDATE wr SET status='Com' WHERE 1=1")).catch(function () {});
`;

function gridPage(v: MockView, withXls: boolean): string {
  const captions = v.exports[v.exports.length - 1] ?? [];
  const xls = withXls ? v.exports.map((_, i) => `<input type="button" value="XLS" data-xls="${i}">`).join(' ') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.title)}</title></head><body>
<h2>${esc(v.title)}</h2>
<div class="filter">${v.hasShow ? '<input type="button" value="Show" id="btnShow">' : ''} <input type="button" value="Clear" id="btnClear"></div>
${trapPanel()}
<div class="exports">${xls}</div>
<table id="grid" border="1"><thead><tr>${captions.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody></tbody></table>
<div class="pager"><input type="button" value="Previous" id="prev"> <span id="pageNo"></span> <input type="button" value="Next" id="next"></div>
<script>
var VIEW = ${JSON.stringify(v.gridView)};
${PAGE_SCRIPT_COMMON}
var rows = [], pageNo = 0, PER = 2;
function render() {
  var tb = document.querySelector('#grid tbody'); tb.innerHTML = '';
  rows.slice(pageNo * PER, pageNo * PER + PER).forEach(function (r) {
    var tr = document.createElement('tr');
    r.forEach(function (c) { var td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    tb.appendChild(tr);
  });
  document.getElementById('pageNo').textContent = rows.length ? (pageNo + 1) + ' / ' + Math.ceil(rows.length / PER) : '';
}
function load() { return dwr(VIEW, 'AbCommonResources-getDataRecords').then(function (r) { rows = r.records || []; pageNo = 0; render(); }); }
var show = document.getElementById('btnShow');
if (show) show.addEventListener('click', load); else load();
document.getElementById('btnClear').addEventListener('click', function () { rows = []; render(); });
document.getElementById('prev').addEventListener('click', function () { if (pageNo > 0) { pageNo--; render(); } });
document.getElementById('next').addEventListener('click', function () { if ((pageNo + 1) * PER < rows.length) { pageNo++; render(); } });
document.querySelectorAll('[data-xls]').forEach(function (b) {
  b.addEventListener('click', function () {
    dwr(VIEW, 'AbSystemAdministration-generateGridXLSReport', 'c0-e3=number:' + b.getAttribute('data-xls')).then(function (r) {
      if (!r.url) return;
      var a = document.createElement('a'); a.href = r.url; a.download = ''; document.body.appendChild(a); a.click();
    });
  });
});
</script></body></html>`;
}

function tabsPage(v: MockView): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.title)}</title></head><body>
<h1>${esc(v.title)}</h1>
<div class="tabs"><span class="tab selected">Select</span> <span class="tab">Details</span></div>
${trapPanel()}
<iframe id="tabFrame" src="/archibus/${esc(v.gridView)}" style="width:100%;height:700px;border:0"></iframe>
<script>var VIEW = ${JSON.stringify(v.view.split('?')[0])};${PAGE_SCRIPT_COMMON}</script>
</body></html>`;
}

function forbiddenPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Approve Work Request</title></head><body>
<h1>Approve Work Request</h1>${trapPanel()}<script>var VIEW = ${JSON.stringify(FORBIDDEN_VIEW)};${PAGE_SCRIPT_COMMON}</script></body></html>`;
}

interface Session {
  user: string;
  pageLoads: number;
}

export async function startMockPortal(opts: MockOptions): Promise<MockPortal> {
  const creds = opts.credentials;
  const lockAfter = opts.lockAfterFailures ?? 3;
  const noXls = new Set(opts.listsWithoutXls ?? []);
  const sessions = new Map<string, Session>();
  const files = new Map<string, { view: MockView; idx: number }>();
  const traps: TrapHit[] = [];
  const st: MockStats = {
    signInAttempts: 0,
    failedSignIns: 0,
    successfulSignIns: 0,
    locked: false,
    pageLoads: 0,
    downloads: 0,
    dwrRules: {},
    userAgents: [],
    requests: [],
  };
  const projects = Array.from(new Set([creds.project, 'TRAINING']));

  const trap = (what: string, req: IncomingMessage, path: string) =>
    traps.push({ at: new Date().toISOString(), what, method: req.method ?? '', path });

  const viewByFile = (file: string, search: string): { v: MockView; grid: boolean } | null => {
    for (const v of MOCK_VIEWS) {
      const [mainFile, q] = v.view.split('?');
      if (file === mainFile && (q === undefined || search === `?${q}`)) return { v, grid: v.gridView === mainFile };
      if (file === v.gridView) return { v, grid: true };
    }
    return null;
  };

  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const html = (res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) =>
    send(res, status, body, { 'content-type': 'text/html; charset=utf-8', ...headers });
  const json = (res: ServerResponse, obj: unknown, status = 200) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });
  const toLogin = (res: ServerResponse) => send(res, 302, '', { location: '/archibus/login.axvw' });

  async function exportBytes(view: MockView, idx: number): Promise<Buffer> {
    const last = idx === view.exports.length - 1;
    if (last && opts.fixturesDir) {
      const f = await findFixture(opts.fixturesDir, view.key);
      if (f && /\.xlsx$/i.test(f.name)) return f.data;
    }
    return generateXlsx(view.exports[idx] ?? []);
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'mock error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Test-only endpoints (not part of the imitation).
    if (path === '/__trap-log') return json(res, traps);
    if (path === '/__stats') return json(res, st);

    st.requests.push({ method, path });
    const ua = req.headers['user-agent'] ?? '';
    if (ua && !st.userAgents.includes(ua)) st.userAgents.push(ua);
    const sid = parseCookies(req).JSESSIONID;
    const session = sid ? sessions.get(sid) : undefined;

    if (path === '/archibus/login.axvw') {
      if (method === 'GET') return html(res, loginPage(projects));
      if (method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        st.signInAttempts++;
        let error: string | undefined;
        if (st.locked) error = 'Your account is locked. Contact the administrator.';
        else if (st.signInAttempts <= (opts.internalErrorFirstN ?? 0)) error = 'Internal error';
        else if (form.get('project') !== creds.project || form.get('username') !== creds.username || form.get('password') !== creds.password) {
          error = 'Invalid username or password.';
        }
        if (error) {
          st.failedSignIns++;
          if (st.failedSignIns >= lockAfter) st.locked = true;
          return html(res, loginPage(projects, error));
        }
        st.successfulSignIns++;
        const newSid = randomBytes(16).toString('hex');
        sessions.set(newSid, { user: creds.username, pageLoads: 0 });
        return send(res, 302, '', { location: '/archibus/index.html', 'set-cookie': `JSESSIONID=${newSid}; Path=/archibus; HttpOnly; SameSite=Lax` });
      }
      return send(res, 405, '');
    }

    if (path.startsWith('/archibus/__trap/')) {
      trap(`button ${path.slice('/archibus/__trap/'.length)}`, req, path);
      return json(res, { ok: true });
    }

    if (path === '/archibus/' || path === '/archibus/index.html') {
      if (!session) return toLogin(res);
      return html(res, '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home (mock)</h1></body></html>');
    }

    if (path === `/archibus/${FORBIDDEN_VIEW}`) {
      trap(`forbidden view ${FORBIDDEN_VIEW}`, req, path);
      if (!session) return toLogin(res);
      return html(res, forbiddenPage());
    }

    if (path === '/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr' && method === 'POST') {
      const body = await readBody(req);
      const f = parseDwr(body);
      const rule = dec(f.get('c0-param0'));
      st.dwrRules[rule] = (st.dwrRules[rule] ?? 0) + 1;
      if (!ALLOWED_RULES.has(rule)) trap(`rule ${rule}`, req, path);
      if (!session) return json(res, { error: 'session expired' }, 401);
      if (!ALLOWED_RULES.has(rule)) return json(res, { ok: true });
      const viewName = dec(f.get('c0-e1'));
      const v = MOCK_VIEWS.find((m) => m.gridView === viewName || m.view.split('?')[0] === viewName);
      if (!v) return json(res, { error: 'unknown view' }, 400);
      if (rule === 'AbCommonResources-getDataRecords') {
        const caps = v.exports[v.exports.length - 1] ?? [];
        const records = [1, 2, 3, 4, 5].map((r) => caps.map((c) => `${c} ${r}`));
        return json(res, { records });
      }
      const idx = Number(dec(f.get('c0-e3')) || '0');
      if (noXls.has(v.key)) return json(res, { error: 'no export' }, 400);
      const name = `${v.gridView.replace(/\.axvw$/, '')}-${randomBytes(4).toString('hex')}.xlsx`;
      files.set(name, { view: v, idx });
      return json(res, { url: `/archibus/projects/users/${encodeURIComponent(session.user)}/${name}` });
    }

    const fileMatch = path.match(/^\/archibus\/projects\/users\/[^/]+\/([^/]+\.xlsx)$/);
    if (fileMatch && method === 'GET') {
      if (!session) return toLogin(res);
      const entry = files.get(fileMatch[1] as string);
      if (!entry) return send(res, 404, 'not found');
      st.downloads++;
      const data = await exportBytes(entry.view, entry.idx);
      return send(res, 200, data, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${fileMatch[1]}"`,
      });
    }

    if (path.endsWith('.axvw') && method === 'GET') {
      const file = path.slice('/archibus/'.length);
      const hit = viewByFile(file, url.search);
      if (!hit) {
        trap(`unknown view ${file}`, req, path);
        return send(res, 404, 'unknown view');
      }
      if (!session) return toLogin(res);
      if (req.headers['sec-fetch-dest'] === 'document') {
        session.pageLoads++;
        st.pageLoads++;
        const k = opts.sessionExpiresAfterPageLoads;
        if (k !== undefined && session.pageLoads > k) {
          if (sid) sessions.delete(sid);
          return toLogin(res);
        }
      }
      if (hit.grid) return html(res, gridPage(hit.v, !noXls.has(hit.v.key)));
      return html(res, tabsPage(hit.v));
    }

    if (path === '/favicon.ico') return send(res, 404, '');
    trap(`unexpected ${method} ${path}`, req, path);
    return send(res, 404, 'not found');
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/archibus/`,
    stats: () => JSON.parse(JSON.stringify(st)) as MockStats,
    trapLog: () => traps.slice(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
