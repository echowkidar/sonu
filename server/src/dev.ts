/**
 * Local development entry (npm run dev). Not used in Docker.
 *
 * - Loads ../.env and ./.env when present.
 * - No DATABASE_URL → starts a real PostgreSQL via the `embedded-postgres` dev dependency
 *   (data in the OS temp folder, port 54330). With Docker you can instead run
 *   `docker compose -f docker-compose.dev.yml up -d` and set
 *   DATABASE_URL=postgres://sonu:sonu-dev@localhost:54329/sonu
 * - No ENCRYPTION_KEY → generates a dev-only key and keeps it next to the dev database.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverRoot } from './config.js';

const root = serverRoot();
for (const f of [path.resolve(root, '..', '.env'), path.join(root, '.env')]) {
  if (fs.existsSync(f)) process.loadEnvFile(f);
}

const devDir = path.join(os.tmpdir(), 'sonu-dev');
fs.mkdirSync(devDir, { recursive: true });

if (!process.env.ENCRYPTION_KEY) {
  const keyFile = path.join(devDir, 'encryption.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  process.env.ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  console.warn(`[dev] ENCRYPTION_KEY not set — using a dev-only key from ${keyFile}`);
}

let stopDb: (() => Promise<void>) | null = null;

if (!process.env.DATABASE_URL) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = path.join(devDir, 'pg-data');
  const port = Number(process.env.DEV_PG_PORT ?? 54330);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'sonu', password: 'sonu-dev', port, persistent: true, onLog: () => undefined, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('sonu');
  } catch {
    /* exists already */
  }
  process.env.DATABASE_URL = `postgres://sonu:sonu-dev@127.0.0.1:${port}/sonu`;
  stopDb = () => pg.stop();
  console.warn(`[dev] using embedded PostgreSQL on port ${port} (data in ${dataDir})`);
}

process.env.PORT ??= '3000';
process.env.LOG_LEVEL ??= 'info';

const { main } = await import('./index.js');
const app = await main(process.env, { handleSignals: false });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void (async () => {
      await app.close().catch(() => undefined);
      if (stopDb) await stopDb().catch(() => undefined);
      process.exit(0);
    })();
  });
}
