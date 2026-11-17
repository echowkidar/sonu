import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { inject } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { initApp } from '../src/startup.js';
import type { TransportOptions } from '../src/mail/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.resolve(here, '..', '..', 'assets');

/** Creates an empty database on the test server and returns its URL. */
export async function createTestDatabase(): Promise<string> {
  const adminUrl = inject('pgAdminUrl');
  const name = `sonu_t_${crypto.randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`CREATE DATABASE ${name} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  await c.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface SentMail {
  options: TransportOptions;
  message: { from?: unknown; to?: unknown; subject?: string; text?: string };
}

export interface TestContext {
  app: FastifyInstance;
  db: Pool;
  config: Config;
  sent: SentMail[];
  close(): Promise<void>;
}

export async function makeTestApp(overrides: Partial<Record<string, string>> = {}): Promise<TestContext> {
  const databaseUrl = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    PUBLIC_URL: 'https://sonu.example.test',
    ASSETS_DIR,
    WEB_DIST: path.join(here, 'no-web-dist'),
    UPLOAD_DIR: path.join(here, '..', '.data', 'test-uploads'),
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const db = createPool(databaseUrl, 5);
  const sent: SentMail[] = [];
  const app = await buildApp({
    config,
    pool: db,
    logger: false,
    // Real nodemailer, but jsonTransport: nothing leaves the machine, every message is captured.
    mailTransportFactory: (options) => {
      const t = nodemailer.createTransport({ jsonTransport: true });
      const orig = t.sendMail.bind(t);
      (t as unknown as { sendMail: typeof orig }).sendMail = (async (mail: Parameters<typeof orig>[0]) => {
        const info = await orig(mail);
        sent.push({ options, message: JSON.parse((info as unknown as { message: string }).message) });
        return info;
      }) as typeof orig;
      return t;
    },
  });
  await initApp(app);
  return {
    app,
    db,
    config,
    sent,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

/** Minimal cookie-jar client around app.inject. */
export class Client {
  cookie = '';
  constructor(private readonly app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.csrf !== false) headers['x-requested-with'] = 'sonu';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.inject({ method, url, payload: body as never, headers });
    this.capture(res);
    return res;
  }

  capture(res: LightMyRequestResponse) {
    const set = res.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [set] : [];
    for (const c of list) {
      const [pair] = c.split(';');
      if (pair?.startsWith('sonu_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown, opts?: { csrf?: boolean }) => this.req('POST', url, body ?? {}, opts);
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);
}

export const PASSWORD = 'Correct-Horse-42';

/** Runs first-run setup and returns a signed-in platform admin client. */
export async function setupPlatformAdmin(ctx: TestContext): Promise<Client> {
  const c = new Client(ctx.app);
  const res = await c.post('/api/setup', { code: ctx.app.setupState.code, email: 'platform@example.com', fullName: 'Platform Owner', password: PASSWORD });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return c;
}

/** Latest invitation / reset token for an e-mail, read from the log-driver outbox. */
export async function tokenFromOutbox(db: Pool, email: string, kind: 'accept-invite' | 'reset-password' = 'accept-invite'): Promise<string> {
  const r = await db.query<{ body_text: string }>(
    'SELECT body_text FROM mail_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC LIMIT 1',
    [email],
  );
  const m = r.rows[0]?.body_text.match(new RegExp(`/${kind}\\?token=([A-Za-z0-9_%-]+)`));
  if (!m) throw new Error(`no ${kind} link for ${email}`);
  return decodeURIComponent(m[1]!);
}

/** Creates a contractor (with admin invited), accepts the invitation, returns the admin client and ids. */
export async function createContractorWithAdmin(platform: Client, ctx: TestContext, code: string, adminEmail: string) {
  const res = await platform.post('/api/admin/contractors', {
    code,
    name: `${code} Facilities W.L.L.`,
    marafiqWorkTeams: [`WT-${code}-Z1`, `WT-${code}-Z2`],
    admin: { fullName: `Admin ${code}`, email: adminEmail },
  });
  if (res.statusCode !== 201) throw new Error(`create contractor failed: ${res.body}`);
  const contractorId = res.json().contractor.id as string;
  const token = await tokenFromOutbox(ctx.db, adminEmail);
  const admin = new Client(ctx.app);
  const acc = await admin.post('/api/auth/accept-invite', { token, password: PASSWORD });
  if (acc.statusCode !== 200) throw new Error(`accept failed: ${acc.body}`);
  return { admin, contractorId, adminUserId: res.json().adminUserId as string };
}
