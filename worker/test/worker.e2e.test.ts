/**
 * End-to-end scenarios: real Chromium (Playwright) against the LOCAL mock portal and a fake SONU app.
 * After every scenario: the trap log is empty and the password never appears in the logs.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIST_KEYS } from '../src/allowlist.js';
import { USER_AGENT_SUFFIX } from '../src/config.js';
import { MOCK_VIEWS } from '../mock-portal/views.js';
import { runScenario, type ScenarioOutput } from './helpers/scenario.js';

let current: ScenarioOutput | null = null;

afterEach(async () => {
  if (!current) return;
  const s = current;
  current = null;
  try {
    // 1. No trap was ever touched (Save/Delete/... buttons, generic SQL rule, non-allow-listed view).
    expect(s.mock.trapLog()).toEqual([]);
    expect(s.mock.stats().dwrRules['AbCommonResources-executeCustomSQL']).toBeUndefined();
    expect(s.mock.stats().dwrRules['AbCommonResources-saveRecord']).toBeUndefined();
    // 2. Neither the correct nor the submitted password appears in any log line.
    const all = s.logs.join('\n');
    expect(all).not.toContain(s.password);
    expect(all).not.toContain(s.jobPassword);
    expect(all).not.toContain(encodeURIComponent(s.password));
  } finally {
    await s.close();
  }
});

const loginPosts = (s: ScenarioOutput) => s.mock.stats().requests.filter((r) => r.method === 'POST' && r.path === '/archibus/login.axvw').length;
const viewLoads = (s: ScenarioOutput) =>
  s.mock.stats().requests.filter((r) => r.path.endsWith('.axvw') && r.path !== '/archibus/login.axvw').length;

describe('worker against the mock portal', () => {
  it('the mock imitates every allow-listed list', () => {
    expect(MOCK_VIEWS.map((v) => v.key).sort()).toEqual([...LIST_KEYS].sort());
  });

  it('successful sync uploads every requested list with the exact captions', async () => {
    current = await runScenario({ lists: [...LIST_KEYS] });
    const s = current;
    expect(s.result.status).toBe('ok');
    expect(s.result.signInAttempts).toBe(1);
    expect(s.app.uploads.map((u) => u.listKey)).toEqual([...LIST_KEYS]);
    for (const u of s.app.uploads) expect(u.captionsOk, `${u.listKey}: ${u.header.join(' | ')}`).toBe(true);
    expect(s.result.lists).toHaveLength(LIST_KEYS.length);
    for (const l of s.result.lists) expect(l).toMatchObject({ ok: true, rows: 3 });
    const st = s.mock.stats();
    expect(st.signInAttempts).toBe(1);
    expect(st.downloads).toBe(LIST_KEYS.length);
    // Honest user agent.
    expect(st.userAgents.length).toBeGreaterThan(0);
    for (const ua of st.userAgents) expect(ua).toContain(USER_AGENT_SUFFIX);
    // The portal pages' own on-load SQL calls were stopped by the guard, not by luck.
    expect(s.result.message ?? '').toContain('AbCommonResources-executeCustomSQL');
    // All three endpoints were called with the bearer token.
    expect(s.app.requests.every((r) => r.authorized)).toBe(true);
  });

  it('test-connection job: signs in, opens the first list, finds Show, presses nothing', async () => {
    current = await runScenario({ kind: 'test' });
    const s = current;
    expect(s.result.status).toBe('ok');
    expect(s.result.signInAttempts).toBe(1);
    expect(s.result.lists).toEqual([{ key: LIST_KEYS[0], ok: true }]);
    expect(s.app.uploads).toHaveLength(0);
    const st = s.mock.stats();
    expect(st.dwrRules['AbCommonResources-getDataRecords']).toBeUndefined(); // Show was not pressed
    expect(st.downloads).toBe(0);
  });

  it('wrong password: exactly 2 attempts, then signin_failed and nothing more', async () => {
    current = await runScenario({ lists: ['boq_details', 'issue_wr'], jobPassword: 'wrong-Password-123' });
    const s = current;
    expect(s.result.status).toBe('signin_failed');
    expect(s.result.signInAttempts).toBe(2);
    expect(s.result.message).toContain('Invalid username or password');
    expect(loginPosts(s)).toBe(2);
    expect(s.mock.stats().signInAttempts).toBe(2);
    expect(s.mock.stats().locked).toBe(false); // the mock locks after 3 — never reached
    expect(viewLoads(s)).toBe(0);
    expect(s.app.uploads).toHaveLength(0);
    const before = s.mock.stats().requests.length;
    expect(await s.pollAgain()).toBe(false); // no job queued
    expect(s.mock.stats().requests.length).toBe(before);
  });

  it('"Internal error" twice: stops at 2 attempts with signin_failed', async () => {
    current = await runScenario({ lists: ['boq_details'], mock: { internalErrorFirstN: 2 } });
    const s = current;
    expect(s.result.status).toBe('signin_failed');
    expect(s.result.signInAttempts).toBe(2);
    expect(s.result.message).toContain('Internal error');
    expect(s.mock.stats().signInAttempts).toBe(2);
    expect(s.mock.stats().successfulSignIns).toBe(0);
    expect(viewLoads(s)).toBe(0);
  });

  it('"Internal error" once, then success: continues and reads the lists', async () => {
    current = await runScenario({ lists: ['boq_details', 'pending_rfe_status'], mock: { internalErrorFirstN: 1 } });
    const s = current;
    expect(s.result.status).toBe('ok');
    expect(s.result.signInAttempts).toBe(2);
    expect(s.app.uploads.map((u) => u.listKey)).toEqual(['boq_details', 'pending_rfe_status']);
    expect(s.mock.stats().signInAttempts).toBe(2);
  });

  it('session expiry mid-run: re-sign-in counted within the same budget of 2', async () => {
    current = await runScenario({
      lists: ['boq_details', 'pending_rfe_status', 'edit_update_wrs'],
      mock: { sessionExpiresAfterPageLoads: 2 },
    });
    const s = current;
    expect(s.result.status).toBe('ok');
    expect(s.result.signInAttempts).toBe(2);
    expect(s.mock.stats().signInAttempts).toBe(2);
    expect(s.app.uploads).toHaveLength(3);
  });

  it('session expiring a second time: no third sign-in; remaining list reported', async () => {
    current = await runScenario({
      lists: ['boq_details', 'pending_rfe_status', 'edit_update_wrs'],
      mock: { sessionExpiresAfterPageLoads: 1 },
    });
    const s = current;
    expect(s.mock.stats().signInAttempts).toBe(2);
    expect(s.result.signInAttempts).toBe(2);
    expect(s.result.status).toBe('error');
    const byKey = Object.fromEntries(s.result.lists.map((l: any) => [l.key, l]));
    expect(byKey.boq_details.ok).toBe(true);
    expect(byKey.pending_rfe_status.ok).toBe(true);
    expect(byKey.edit_update_wrs.ok).toBe(false);
  });

  it('one list failing (no XLS on the page) does not stop the others', async () => {
    current = await runScenario({
      lists: ['estimate_and_schedule', 'issue_wr', 'rfe_post_box'],
      mock: { listsWithoutXls: ['issue_wr'] },
      config: { stepTimeoutMs: 3000 },
    });
    const s = current;
    expect(s.result.status).toBe('error');
    const byKey = Object.fromEntries(s.result.lists.map((l: any) => [l.key, l]));
    expect(byKey.estimate_and_schedule.ok).toBe(true);
    expect(byKey.rfe_post_box.ok).toBe(true);
    expect(byKey.issue_wr.ok).toBe(false);
    expect(byKey.issue_wr.error).toMatch(/XLS/);
    expect(s.app.uploads.map((u) => u.listKey)).toEqual(['estimate_and_schedule', 'rfe_post_box']);
    expect(s.result.signInAttempts).toBe(1);
  });

  it('unknown list key is ignored and reported', async () => {
    current = await runScenario({ lists: ['boq_details', 'drop_tables', 'boq_details'] });
    const s = current;
    expect(s.result.status).toBe('ok');
    expect(s.result.lists).toEqual([
      { key: 'boq_details', ok: true, rows: 3 },
      { key: 'drop_tables', ok: false, error: 'unknown list key (ignored)' },
    ]);
    expect(s.app.uploads).toHaveLength(1);
  });

  const fixturesDir = join(import.meta.dirname, '..', '..', 'fixtures');
  const fixtureKeys = existsSync(fixturesDir)
    ? LIST_KEYS.filter((k) => readdirSync(fixturesDir).some((n) => /\.xlsx$/i.test(n) && n.toLowerCase().replace(/[-\s]/g, '_').includes(k)))
    : [];
  it.skipIf(fixtureKeys.length === 0)('hands the synthetic fixtures from app/fixtures over unchanged', async () => {
    current = await runScenario({ lists: fixtureKeys, mock: { fixturesDir } });
    const s = current;
    expect(s.result.signInAttempts).toBe(1);
    expect(s.app.uploads.map((u) => u.listKey)).toEqual(fixtureKeys);
  });

  it('refuses a non-https portal address without opening a browser', async () => {
    current = await runScenario({
      lists: ['boq_details'],
      baseUrl: () => 'http://portal.example.test/archibus/',
    });
    const s = current;
    expect(s.result.status).toBe('error');
    expect(s.result.message).toMatch(/refused/);
    expect(s.result.signInAttempts).toBe(0);
    expect(s.mock.stats().requests).toHaveLength(0);
  });

  it('refuses http to localhost unless ALLOW_INSECURE_PORTAL is set', async () => {
    current = await runScenario({ lists: ['boq_details'], config: { allowInsecurePortal: false } });
    const s = current;
    expect(s.result.status).toBe('error');
    expect(s.result.message).toMatch(/https/);
    expect(s.mock.stats().requests).toHaveLength(0);
  });
});
