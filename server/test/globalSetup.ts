/**
 * Test database: TEST_DATABASE_URL (e.g. the dev compose DB on port 54329) when set, otherwise a
 * throw-away PostgreSQL started with the `embedded-postgres` package (real binaries, no Docker).
 * Each test file then creates its own database on that server.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgAdminUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonu-test-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, onLog: () => undefined, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise();
  await pg.start();
  project.provide('pgAdminUrl', `postgres://postgres:test@127.0.0.1:${port}/postgres`);
  return async () => {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
