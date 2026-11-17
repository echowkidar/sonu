import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptionKeyError, hasSecret, parseEncryptionKey, putSecret, readSecret, redactSecrets } from '../src/secrets.js';
import { Client, createContractorWithAdmin, makeTestApp, setupPlatformAdmin, type TestContext } from './helpers.js';

const SMTP_PW = 'Smtp-App-Pw-7f3k9Q';
const MARAFIQ_PW = 'Marafiq-Secret-91xZ';
const OAUTH_SECRET = 'oauth-client-secret-Zx81';
const REFRESH = 'refresh-token-Qp55-abcdef';

describe('secrets', () => {
  let ctx: TestContext;
  let platform: Client;
  let admin: Client;
  let contractorId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    platform = await setupPlatformAdmin(ctx);
    ({ admin, contractorId } = await createContractorWithAdmin(platform, ctx, 'SECA', 'admin.seca@example.com'));
  });
  afterAll(async () => ctx?.close());

  it('rejects a missing or wrong-length ENCRYPTION_KEY with a clear message', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('')).toThrow(/openssl rand -base64 32/);
    expect(() => parseEncryptionKey(crypto.randomBytes(16).toString('base64'))).toThrow(/32 bytes \(got 16\)/);
    expect(parseEncryptionKey(crypto.randomBytes(32).toString('base64')).length).toBe(32);
  });

  it('round-trips, replaces in place, and never stores clear text', async () => {
    const id = await putSecret(ctx.db, { contractorId, purpose: 'test.value', value: 'first-Value-1' });
    expect(await readSecret(ctx.db, id)).toBe('first-Value-1');
    expect(await hasSecret(ctx.db, id)).toBe(true);
    const same = await putSecret(ctx.db, { contractorId, purpose: 'test.value', value: 'second-Value-2', id });
    expect(same).toBe(id);
    expect(await readSecret(ctx.db, id)).toBe('second-Value-2');
    // Tenant check: another contractor (or platform) cannot read it.
    expect(await readSecret(ctx.db, id, null)).toBeNull();
    const raw = await ctx.db.query('SELECT ciphertext::text AS c FROM secret WHERE id = $1', [id]);
    expect(raw.rows[0].c).not.toContain('second-Value-2');
    // Tampering is detected by GCM.
    await ctx.db.query(`UPDATE secret SET ciphertext = set_byte(ciphertext, 0, (get_byte(ciphertext, 0) + 1) % 256) WHERE id = $1`, [id]);
    await expect(readSecret(ctx.db, id)).rejects.toThrow();
  });

  it('redactSecrets removes secret-looking keys', () => {
    expect(redactSecrets({ a: 1, password: 'x', nested: { refreshToken: 'y', hasPassword: true } })).toEqual({
      a: 1,
      password: '[redacted]',
      nested: { refreshToken: '[redacted]', hasPassword: true },
    });
  });

  it('no API response or audit row contains a stored password', async () => {
    const put = await admin.put('/api/admin/mail', {
      driver: 'smtp',
      fromAddress: 'maintenance@example.com',
      fromName: 'Maintenance',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'maintenance@example.com',
      password: SMTP_PW,
      oauthClientSecret: OAUTH_SECRET,
      oauthRefreshToken: REFRESH,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().hasPassword).toBe(true);
    const conn = await admin.put('/api/admin/marafiq-connection', { baseUrl: 'https://portal.example.com', username: 'svc-sonu', password: MARAFIQ_PW });
    expect(conn.statusCode).toBe(200);
    expect(conn.json().hasPassword).toBe(true);

    const bodies = [
      put.body,
      conn.body,
      (await admin.get('/api/admin/mail')).body,
      (await admin.get('/api/admin/marafiq-connection')).body,
      (await admin.get('/api/admin/audit?pageSize=500')).body,
      (await platform.get(`/api/admin/audit?pageSize=500`)).body,
      (await platform.get(`/api/admin/mail?contractorId=${contractorId}`)).body,
      (await admin.get('/api/auth/me')).body,
    ];
    for (const b of bodies) {
      for (const s of [SMTP_PW, MARAFIQ_PW, OAUTH_SECRET, REFRESH]) expect(b).not.toContain(s);
    }
    const audit = await ctx.db.query('SELECT details::text AS d, coalesce(summary, \'\') AS s FROM audit_log');
    for (const row of audit.rows) {
      for (const s of [SMTP_PW, MARAFIQ_PW, OAUTH_SECRET, REFRESH]) {
        expect(row.d).not.toContain(s);
        expect(row.s).not.toContain(s);
      }
    }
    // Clear text exists nowhere in the database dump of non-secret tables.
    const conns = await ctx.db.query('SELECT row_to_json(m)::text AS j FROM marafiq_connection m UNION ALL SELECT row_to_json(s)::text FROM mail_settings s');
    for (const row of conns.rows) for (const s of [SMTP_PW, MARAFIQ_PW]) expect(row.j).not.toContain(s);
    // But the server itself can still read them.
    const ms = await ctx.db.query('SELECT smtp_password_secret_id AS id FROM mail_settings WHERE contractor_id = $1', [contractorId]);
    expect(await readSecret(ctx.db, ms.rows[0].id, contractorId)).toBe(SMTP_PW);
  });

  it('saving without a password keeps the stored one; clearPassword removes it', async () => {
    const keep = await admin.put('/api/admin/mail', { driver: 'smtp', smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, smtpUser: 'maintenance@example.com' });
    expect(keep.json().hasPassword).toBe(true);
    const cleared = await admin.put('/api/admin/mail', { driver: 'smtp', smtpHost: 'smtp.example.com', smtpPort: 465, clearPassword: true });
    expect(cleared.json().hasPassword).toBe(false);
  });
});
