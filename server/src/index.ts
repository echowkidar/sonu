import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { EncryptionKeyError } from './secrets.js';
import { initApp } from './startup.js';

export async function main(env: NodeJS.ProcessEnv = process.env, opts: { handleSignals?: boolean } = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    console.error(`[sonu] ${(err as Error).message}`);
    process.exit(1);
  }
  let app;
  try {
    app = await buildApp({ config });
  } catch (err) {
    if (err instanceof EncryptionKeyError) {
      console.error(`[sonu] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  try {
    await initApp(app);
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'startup failed');
    await app.close().catch(() => undefined);
    process.exit(1);
  }
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  if (opts.handleSignals !== false) {
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  }
  await app.listen({ port: config.port, host: config.host });
  return app;
}

// Run when executed directly (node dist/index.js), not when imported (dev.ts, tests).
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
