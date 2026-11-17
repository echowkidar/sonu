/**
 * Enforcement of the read-only rules IN CODE (design/14 section 4.3):
 *  (a) every request to another origin is aborted;
 *  (b) navigations only to the login page, read-only landing page, the open allow-listed view(s) and export files;
 *  (c) `clickAllowed` is the only way the worker clicks, and only the labels Show / XLS / Previous / Next;
 *  (d) calls on the portal's rule channel are parsed and refused unless they are a permitted data read
 *      naming the currently open allow-listed view. Default deny.
 * Nothing in this file talks to the portal by itself; it only filters what the browser sends.
 */
import type { BrowserContext, Locator, Page } from 'playwright';
import {
  DWR_CHANNEL_PATHS,
  EXPORT_FILE_PATTERN,
  FORBIDDEN_RULES,
  FORBIDDEN_RULE_PATTERN,
  LANDING_PATHS,
  LOGIN_PATH,
  PERMITTED_BUTTON_LABELS,
  PERMITTED_READ_RULES,
  viewFilePath,
  type ListDef,
} from './allowlist.js';
import type { Logger } from './logger.js';

export class ForbiddenActionError extends Error {
  override name = 'ForbiddenActionError';
}
export class ButtonNotFoundError extends Error {
  override name = 'ButtonNotFoundError';
}

export type GuardPhase = 'idle' | 'signin' | 'list';

export interface RequestInfo {
  url: string;
  method: string;
  isNavigation: boolean;
  resourceType: string;
  postData: string | null;
}

export type Decision = { allow: true; ruleIds?: string[] } | { allow: false; reason: string; ruleIds?: string[] };

export interface BlockedRecord {
  reason: string;
  method: string;
  /** origin + path only — never the query string or body. */
  where: string;
  ruleIds?: string[];
}

const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const MAX_DWR_BODY = 100_000;
const MAX_DWR_CALLS = 5;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Inspect the body of a rule-channel (DWR) call. Exported for unit tests. */
export function inspectDwrBody(body: string | null, allowedViews: ReadonlySet<string>): Decision {
  if (!body) return { allow: false, reason: 'rule call without body' };
  if (body.length > MAX_DWR_BODY) return { allow: false, reason: 'rule call body too large' };
  const decoded = safeDecode(body);
  for (const r of FORBIDDEN_RULES) {
    if (body.includes(r) || decoded.includes(r)) return { allow: false, reason: `forbidden rule ${r}`, ruleIds: [r] };
  }
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  const callCount = Number(fields.get('callCount'));
  if (!Number.isInteger(callCount) || callCount < 1 || callCount > MAX_DWR_CALLS) {
    return { allow: false, reason: 'rule call with invalid callCount' };
  }
  const ruleIds: string[] = [];
  for (let c = 0; c < callCount; c++) {
    const script = fields.get(`c${c}-scriptName`);
    const method = fields.get(`c${c}-methodName`);
    if (script !== 'workflow' || method !== 'runWorkflowRule') {
      return { allow: false, reason: `rule channel method not permitted: ${script}.${method}`, ruleIds };
    }
    const raw = fields.get(`c${c}-param0`) ?? '';
    const ruleId = safeDecode(raw.replace(/^string:/, '')).trim();
    ruleIds.push(ruleId);
    if (FORBIDDEN_RULES.includes(ruleId) || FORBIDDEN_RULE_PATTERN.test(ruleId) || !PERMITTED_READ_RULES.includes(ruleId)) {
      return { allow: false, reason: `rule not permitted: ${ruleId || '(none)'}`, ruleIds };
    }
  }
  const views = new Set((decoded.match(/[A-Za-z0-9_.-]+\.axvw/g) ?? []).map((v) => v.split('/').pop() as string));
  if (views.size === 0) return { allow: false, reason: 'rule call does not name a view', ruleIds };
  for (const v of views) {
    if (!allowedViews.has(v)) return { allow: false, reason: `rule call names a view outside the allow-list: ${v}`, ruleIds };
  }
  return { allow: true, ruleIds };
}

export class PortalGuard {
  readonly origin: string;
  private phase: GuardPhase = 'idle';
  private list: ListDef | null = null;
  readonly blocked: BlockedRecord[] = [];
  private mainPages = new WeakSet<Page>();
  private expectingPage = false;

  constructor(baseUrl: string, private readonly logger: Logger) {
    this.origin = new URL(baseUrl).origin;
  }

  beginSignIn(): void {
    this.phase = 'signin';
    this.list = null;
  }
  beginList(def: ListDef): void {
    this.phase = 'list';
    this.list = def;
  }
  idle(): void {
    this.phase = 'idle';
    this.list = null;
  }
  get currentPhase(): GuardPhase {
    return this.phase;
  }

  private currentViews(): Set<string> {
    if (!this.list) return new Set();
    return new Set([this.list.viewPath.split('?')[0] as string, this.list.gridView]);
  }

  private isCurrentView(url: URL): boolean {
    if (!this.list) return false;
    const main = this.list.viewPath;
    const [mainFile, mainQuery] = main.split('?');
    if (url.pathname === viewFilePath(this.list.gridView) && url.search === '') return true;
    if (url.pathname === viewFilePath(mainFile as string)) {
      return (url.search.replace(/^\?/, '') || undefined) === mainQuery;
    }
    return false;
  }

  /** Pure decision for one request. */
  decide(req: RequestInfo): Decision {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return { allow: false, reason: 'unparseable url' };
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return { allow: true };
    if (url.origin !== this.origin) return { allow: false, reason: 'cross-origin request' };
    const method = req.method.toUpperCase();
    const path = url.pathname;

    if (method === 'GET' || method === 'HEAD') {
      if (path === LOGIN_PATH) return { allow: true };
      if (LANDING_PATHS.includes(path)) {
        return req.isNavigation && this.phase === 'signin' ? { allow: true } : { allow: false, reason: 'landing page outside sign-in' };
      }
      if (path.endsWith('.axvw')) {
        if (this.phase === 'list' && this.isCurrentView(url)) return { allow: true };
        return { allow: false, reason: 'view not allow-listed for the current step' };
      }
      if (EXPORT_FILE_PATTERN.test(path)) {
        return this.phase === 'list' ? { allow: true } : { allow: false, reason: 'export file outside a list read' };
      }
      if (!req.isNavigation && STATIC_TYPES.has(req.resourceType) && !/\.(dwr|jsp|axvw)$/i.test(path)) return { allow: true };
      return { allow: false, reason: 'address not allow-listed' };
    }

    if (method === 'POST') {
      if (path === LOGIN_PATH) {
        return this.phase === 'signin' && req.isNavigation ? { allow: true } : { allow: false, reason: 'login post outside sign-in' };
      }
      if (DWR_CHANNEL_PATHS.includes(path)) {
        if (this.phase !== 'list') return { allow: false, reason: 'rule call outside a list read' };
        return inspectDwrBody(req.postData, this.currentViews());
      }
      return { allow: false, reason: 'POST not allow-listed' };
    }
    return { allow: false, reason: `method ${method} not permitted` };
  }

  /** Install on a browser context. Must be called before any page is opened. */
  async install(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route, request) => {
      let postData: string | null = null;
      try {
        postData = request.postData();
      } catch {
        postData = null;
      }
      const d = this.decide({
        url: request.url(),
        method: request.method(),
        isNavigation: request.isNavigationRequest(),
        resourceType: request.resourceType(),
        postData,
      });
      if (d.allow) return route.continue();
      this.recordBlocked(request.method(), request.url(), d.reason, d.ruleIds);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    // No pop-up windows: any page not opened by the worker itself is closed at once.
    context.on('page', (p) => {
      if (this.expectingPage) {
        this.expectingPage = false;
        this.mainPages.add(p);
        return;
      }
      if (!this.mainPages.has(p)) void p.close().catch(() => undefined);
    });
  }

  /** Open the single worker page. */
  async openPage(context: BrowserContext): Promise<Page> {
    if (context.pages().length > 0) throw new ForbiddenActionError('worker page already open');
    // The 'page' event fires during newPage(); mark the next page as ours.
    this.expectingPage = true;
    const page = await context.newPage();
    this.expectingPage = false;
    this.mainPages.add(page);
    return page;
  }

  private recordBlocked(method: string, rawUrl: string, reason: string, ruleIds?: string[]): void {
    let where = rawUrl;
    try {
      const u = new URL(rawUrl);
      where = u.origin + u.pathname;
    } catch {
      /* keep */
    }
    const rec: BlockedRecord = { reason, method, where, ...(ruleIds && ruleIds.length ? { ruleIds } : {}) };
    this.blocked.push(rec);
    this.logger.warn('guard blocked request', { ...rec });
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Clicking: the ONLY place in the worker that clicks anything.                                    */
/* ---------------------------------------------------------------------------------------------- */

function assertPermitted(label: string): void {
  if (!(PERMITTED_BUTTON_LABELS as readonly string[]).includes(label)) {
    throw new ForbiddenActionError(`pressing "${label}" is not permitted (allowed: ${PERMITTED_BUTTON_LABELS.join(', ')})`);
  }
}

async function visibleButtons(page: Page, label: string): Promise<Locator[]> {
  const out: Locator[] = [];
  for (const frame of page.frames()) {
    const roles = label === 'Previous' || label === 'Next' ? (['button', 'link'] as const) : (['button'] as const);
    for (const role of roles) {
      const loc = frame.getByRole(role, { name: label, exact: true });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) out.push(item);
      }
    }
  }
  return out;
}

async function findButton(page: Page, label: string, nth: number, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await visibleButtons(page, label);
    const pick = found[nth];
    if (pick) return pick;
    if (Date.now() >= deadline) throw new ButtonNotFoundError(`button "${label}" (#${nth + 1}) not found`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** True if a permitted button is present (used by "Test connection" — does not click). */
export async function hasAllowedButton(page: Page, label: string, timeoutMs = 10_000): Promise<boolean> {
  assertPermitted(label);
  try {
    await findButton(page, label, 0, timeoutMs);
    return true;
  } catch (e) {
    if (e instanceof ButtonNotFoundError) return false;
    throw e;
  }
}

/**
 * Press a button by its visible label. Throws ForbiddenActionError for any label that is not
 * Show / XLS / Previous / Next — Save, Issue, Complete, Delete, Submit, Approve ... can never be pressed.
 */
export async function clickAllowed(page: Page, label: string, opts: { nth?: number; timeoutMs?: number } = {}): Promise<void> {
  assertPermitted(label);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const target = await findButton(page, label, opts.nth ?? 0, timeoutMs);
  // Re-read the element's own label right before pressing (defends against a re-rendered element).
  const value = (await target.getAttribute('value')) ?? (await target.textContent()) ?? '';
  const aria = await target.getAttribute('aria-label');
  const shown = (value.trim() || aria?.trim() || '').replace(/\s+/g, ' ');
  if (shown !== label) throw new ForbiddenActionError(`element label "${shown}" does not match permitted "${label}"`);
  await target.click({ timeout: timeoutMs });
}
