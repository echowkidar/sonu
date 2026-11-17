import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LISTS, LIST_KEYS } from '../src/allowlist.js';
import { checkPortalAddress, loadConfig, VERSION, workerToken } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { MAX_SIGNIN_ATTEMPTS, SignInBudget } from '../src/session.js';
import pkg from '../package.json' with { type: 'json' };

describe('sign-in budget (the single counter)', () => {
  it('allows exactly 2 attempts and never a third', () => {
    expect(MAX_SIGNIN_ATTEMPTS).toBe(2);
    const b = new SignInBudget();
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    for (let i = 0; i < 10; i++) expect(b.tryTake()).toBe(false);
    expect(b.attempts).toBe(2);
    expect(b.remaining).toBe(0);
  });
  it('cannot be raised above 2', () => {
    expect(() => new SignInBudget(3)).toThrow(RangeError);
    expect(() => new SignInBudget(0)).toThrow(RangeError);
    expect(new SignInBudget(1).max).toBe(1);
  });
});

describe('config', () => {
  it('derives the worker token as hex(HMAC-SHA256(key bytes, "sonu-worker-v1"))', () => {
    const key = randomBytes(32);
    const expected = createHmac('sha256', key).update('sonu-worker-v1').digest('hex');
    expect(workerToken(key.toString('base64'))).toBe(expected);
    expect(() => workerToken(randomBytes(16).toString('base64'))).toThrow();
  });
  it('reads env with defaults', () => {
    const c = loadConfig({ APP_URL: 'http://sonu:3000/', ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(c.appUrl).toBe('http://sonu:3000');
    expect(c.pollSeconds).toBe(15);
    expect(c.headless).toBe(true);
    expect(c.allowInsecurePortal).toBe(false);
    expect(() => loadConfig({})).toThrow();
  });
  it('portal address must be https; http only to local hosts with the flag', () => {
    expect(checkPortalAddress('https://portal.example.test/archibus/', false)).toBeNull();
    expect(checkPortalAddress('http://portal.example.test/archibus/', true)).not.toBeNull();
    expect(checkPortalAddress('http://10.0.0.5/archibus/', true)).not.toBeNull();
    expect(checkPortalAddress('http://localhost:8099/archibus/', false)).not.toBeNull();
    expect(checkPortalAddress('http://localhost:8099/archibus/', true)).toBeNull();
    expect(checkPortalAddress('http://127.0.0.1:8099/archibus/', true)).toBeNull();
    expect(checkPortalAddress('http://mock-portal:8099/archibus/', true)).toBeNull();
    expect(checkPortalAddress('ftp://localhost/', true)).not.toBeNull();
    expect(checkPortalAddress('https://user:pw@portal.example.test/', false)).not.toBeNull();
    expect(checkPortalAddress('not a url', true)).not.toBeNull();
  });
  it('version matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe('logger redaction', () => {
  it('never prints a registered secret or secret-named fields', () => {
    const lines: string[] = [];
    const log = new Logger((l) => lines.push(l));
    const pw = 'S3cr3t pass&word';
    log.addSecret(pw);
    const child = log.child({ jobId: 'j1' });
    child.info(`failed with ${pw}`, { password: 'other-value', nested: { msg: `x${pw}y`, apiToken: 'tok' }, enc: encodeURIComponent(pw) });
    child.error('err', { error: new Error(`boom ${pw}`) });
    const all = lines.join('\n');
    expect(all).not.toContain(pw);
    expect(all).not.toContain(encodeURIComponent(pw));
    expect(all).not.toContain('other-value');
    expect(all).not.toContain('tok');
    expect(all).toContain('[REDACTED]');
  });
});

describe('allow-list', () => {
  it('is frozen and complete', () => {
    expect(Object.isFrozen(LISTS)).toBe(true);
    expect(Object.isFrozen(LISTS.boq_details)).toBe(true);
    expect(LIST_KEYS).toEqual([
      'pending_work_requests',
      'review_approved_estimations',
      'wr_dashboard',
      'estimate_and_schedule',
      'edit_update_wrs',
      'issue_wr',
      'rfe_post_box',
      'pending_rfe_status',
      'manage_permit_to_work',
      'end_to_end_wr_to_invoice',
      'boq_details',
    ]);
  });
});
