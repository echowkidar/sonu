import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getList, LIST_KEYS, PERMITTED_BUTTON_LABELS, PERMITTED_READ_RULES } from '../src/allowlist.js';
import { clickAllowed, ForbiddenActionError, hasAllowedButton, inspectDwrBody, PortalGuard } from '../src/guard.js';
import { Logger } from '../src/logger.js';
import { startMockPortal, type MockPortal } from '../mock-portal/server.js';
import { FORBIDDEN_VIEW } from '../mock-portal/views.js';
import { fictionalCredentials } from './helpers/scenario.js';

const quiet = () => new Logger(() => undefined);
const fakePage = {} as Page;

function dwrBody(rule: string, view = 'qf-wr-cost-report.axvw', extra: string[] = []): string {
  return [
    'callCount=1',
    `page=/archibus/${view}`,
    'c0-scriptName=workflow',
    'c0-methodName=runWorkflowRule',
    'c0-id=0',
    `c0-param0=string:${encodeURIComponent(rule)}`,
    `c0-e1=string:${view}`,
    'c0-param1=Object_Object:{viewName:reference:c0-e1}',
    ...extra,
    'batchId=1',
  ].join('\n');
}

describe('clickAllowed — the only way the worker clicks', () => {
  for (const label of ['Save', 'Delete', 'Issue', 'Complete', 'Submit', 'Approve', 'Sign In', 'Clear', 'Refresh', 'show', 'XLS ', '']) {
    it(`refuses "${label}" before touching the page`, async () => {
      await expect(clickAllowed(fakePage, label)).rejects.toBeInstanceOf(ForbiddenActionError);
      await expect(hasAllowedButton(fakePage, label)).rejects.toBeInstanceOf(ForbiddenActionError);
    });
  }
  it('permits exactly Show, XLS and paging', () => {
    expect([...PERMITTED_BUTTON_LABELS]).toEqual(['Show', 'XLS', 'Previous', 'Next']);
    expect(Object.isFrozen(PERMITTED_BUTTON_LABELS)).toBe(true);
  });
});

describe('rule channel inspection', () => {
  const views = new Set(['qf-wr-cost-report.axvw']);
  it('allows a permitted data read for the open view', () => {
    for (const r of PERMITTED_READ_RULES) expect(inspectDwrBody(dwrBody(r), views).allow).toBe(true);
  });
  it('blocks the generic SQL rule, also hidden in a batch or encoded', () => {
    expect(inspectDwrBody(dwrBody('AbCommonResources-executeCustomSQL'), views).allow).toBe(false);
    const batch = dwrBody('AbCommonResources-getDataRecords').replace('callCount=1', 'callCount=2') +
      '\nc1-scriptName=workflow\nc1-methodName=runWorkflowRule\nc1-param0=string:AbCommonResources%2DexecuteCustomSQL';
    expect(inspectDwrBody(batch, views).allow).toBe(false);
  });
  it('blocks unknown and write-like rules by default', () => {
    for (const r of ['AbCommonResources-saveRecord', 'AbBldgOpsOnDemandWork-qfWorkRequestService-approvePendingRFE', 'AbCommonResources-getUser', 'Anything-new']) {
      expect(inspectDwrBody(dwrBody(r), views).allow).toBe(false);
    }
  });
  it('blocks reads naming a view outside the allow-list, or no view', () => {
    expect(inspectDwrBody(dwrBody('AbCommonResources-getDataRecords', FORBIDDEN_VIEW), views).allow).toBe(false);
    expect(inspectDwrBody(dwrBody('AbCommonResources-getDataRecords', 'qf-wr-cost-report.axvw', [`c0-e9=string:${FORBIDDEN_VIEW}`]), views).allow).toBe(false);
    const noView = ['callCount=1', 'c0-scriptName=workflow', 'c0-methodName=runWorkflowRule', 'c0-param0=string:AbCommonResources-getDataRecords'].join('\n');
    expect(inspectDwrBody(noView, views).allow).toBe(false);
  });
  it('blocks other DWR methods and malformed bodies', () => {
    expect(inspectDwrBody(dwrBody('AbCommonResources-getDataRecords').replace('runWorkflowRule', 'startJob'), views).allow).toBe(false);
    expect(inspectDwrBody(null, views).allow).toBe(false);
    expect(inspectDwrBody('callCount=99', views).allow).toBe(false);
  });
});

describe('request decisions (pure)', () => {
  const origin = 'https://portal.example.test';
  const g = new PortalGuard(origin + '/archibus/', quiet());
  const req = (url: string, over: Partial<Parameters<PortalGuard['decide']>[0]> = {}) =>
    g.decide({ url, method: 'GET', isNavigation: true, resourceType: 'document', postData: null, ...over });

  it('aborts every cross-origin request', () => {
    expect(req('https://cdn.example.com/x.js', { isNavigation: false, resourceType: 'script' }).allow).toBe(false);
    expect(req('http://portal.example.test/archibus/login.axvw').allow).toBe(false); // other scheme = other origin
  });
  it('navigation only to login and the open allow-listed view', () => {
    g.idle();
    expect(req(`${origin}/archibus/login.axvw`).allow).toBe(true);
    expect(req(`${origin}/archibus/qf-wr-cost-report.axvw`).allow).toBe(false); // no list open
    g.beginList(getList('boq_details'));
    expect(req(`${origin}/archibus/qf-wr-cost-report.axvw`).allow).toBe(true);
    expect(req(`${origin}/archibus/${FORBIDDEN_VIEW}`).allow).toBe(false);
    expect(req(`${origin}/archibus/qf-view-ptw-list.axvw`).allow).toBe(false); // allow-listed, but not the open list
    g.beginList(getList('manage_permit_to_work'));
    expect(req(`${origin}/archibus/qf-view-ptw-tabs.axvw?type=requestor`).allow).toBe(true);
    expect(req(`${origin}/archibus/qf-view-ptw-tabs.axvw?type=approver`).allow).toBe(false);
    expect(req(`${origin}/archibus/qf-view-ptw-list.axvw`).allow).toBe(true);
    g.idle();
  });
  it('POST only for the login form during sign-in and inspected rule calls during a list read', () => {
    expect(req(`${origin}/archibus/login.axvw`, { method: 'POST' }).allow).toBe(false);
    g.beginSignIn();
    expect(req(`${origin}/archibus/login.axvw`, { method: 'POST' }).allow).toBe(true);
    expect(req(`${origin}/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr`, { method: 'POST', isNavigation: false, resourceType: 'fetch', postData: dwrBody('AbCommonResources-getDataRecords') }).allow).toBe(false);
    g.beginList(getList('boq_details'));
    expect(req(`${origin}/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr`, { method: 'POST', isNavigation: false, resourceType: 'fetch', postData: dwrBody('AbCommonResources-getDataRecords') }).allow).toBe(true);
    expect(req(`${origin}/archibus/__trap/save`, { method: 'POST', isNavigation: false, resourceType: 'fetch' }).allow).toBe(false);
    expect(req(`${origin}/archibus/qf-wr-cost-report.axvw`, { method: 'PUT' }).allow).toBe(false);
    g.idle();
  });
});

describe('guard in a real browser against the mock', () => {
  let browser: Browser;
  let mock: MockPortal;
  let foreign: MockPortal;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    mock = await startMockPortal({ credentials: fictionalCredentials() });
    foreign = await startMockPortal({ credentials: fictionalCredentials() });
  });
  afterAll(async () => {
    await browser.close();
    await mock.close();
    await foreign.close();
  });

  async function guardedPage(): Promise<{ page: Page; guard: PortalGuard; close: () => Promise<void> }> {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const guard = new PortalGuard(mock.baseUrl, quiet());
    await guard.install(context);
    const page = await guard.openPage(context);
    return { page, guard, close: () => context.close() };
  }

  it('blocks navigation to a non-allow-listed view', async () => {
    const { page, guard, close } = await guardedPage();
    guard.beginList(getList(LIST_KEYS[0]!));
    await expect(page.goto(`${mock.origin}/archibus/${FORBIDDEN_VIEW}`)).rejects.toThrow();
    expect(mock.stats().requests.some((r) => r.path.includes(FORBIDDEN_VIEW))).toBe(false);
    expect(guard.blocked.at(-1)?.reason).toMatch(/view not allow-listed/);
    await close();
  });

  it('aborts cross-origin requests (navigation and fetch)', async () => {
    const first = await guardedPage();
    await expect(first.page.goto(`${foreign.origin}/archibus/login.axvw`)).rejects.toThrow();
    await first.close();
    const { page, close } = await guardedPage();
    await page.goto(`${mock.origin}/archibus/login.axvw`);
    const fetched = await page.evaluate((u) => fetch(u).then(() => 'reached', () => 'blocked'), `${foreign.origin}/archibus/login.axvw`);
    expect(fetched).toBe('blocked');
    expect(foreign.stats().requests).toHaveLength(0);
    await close();
  });

  it('aborts a generic SQL rule call made by page script', async () => {
    const { page, guard, close } = await guardedPage();
    await page.goto(`${mock.origin}/archibus/login.axvw`);
    guard.beginList(getList('boq_details'));
    const body = dwrBody('AbCommonResources-executeCustomSQL', 'qf-wr-cost-report.axvw', ["c0-e2=string:DELETE FROM wr"]);
    const out = await page.evaluate(
      (b) => fetch('/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr', { method: 'POST', body: b }).then(() => 'reached', () => 'blocked'),
      body,
    );
    expect(out).toBe('blocked');
    expect(mock.stats().dwrRules['AbCommonResources-executeCustomSQL']).toBeUndefined();
    expect(guard.blocked.some((b) => b.ruleIds?.includes('AbCommonResources-executeCustomSQL'))).toBe(true);
    expect(mock.trapLog()).toEqual([]);
    await close();
  });

  it('closes any pop-up window', async () => {
    const { page, close } = await guardedPage();
    await page.goto(`${mock.origin}/archibus/login.axvw`);
    const ctx = page.context();
    await page.evaluate(() => void window.open('about:blank'));
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.pages()).toHaveLength(1);
    await close();
  });
});
