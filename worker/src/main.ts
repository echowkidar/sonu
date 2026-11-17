#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { runLoop } from './run.js';

const logger = new Logger(undefined, { svc: 'sonu-worker' });
const cfg = loadConfig();
const ac = new AbortController();
const stop = (sig: string) => {
  if (ac.signal.aborted) return;
  logger.info('shutdown requested; finishing the current step', { signal: sig });
  ac.abort();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

runLoop(cfg, logger, ac.signal).then(
  () => process.exit(0),
  (e) => {
    logger.error('worker crashed', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
