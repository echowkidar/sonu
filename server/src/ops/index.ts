/**
 * Ops module: imports, tracker loader, work requests, dashboard, exports, field jobs, deadline sweep.
 * Registered once in app.ts. Not encapsulated (skip-override) so `app.opsClock` is visible on the root instance.
 *
 *   import { runImport, runDeadlineSweep } from './ops/index.js';
 *   await runImport(app, { contractorId, buffer, fileName, listKey, syncRunId });
 *
 * "today": app.opsClock.today = '2026-11-09' (tests) or env SONU_TODAY (not in production); otherwise
 * today in the contractor's time zone from app.opsClock.now().
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { makeClock } from './context.js';
import importRoutes from './importRoutes.js';
import workRequestRoutes from './workRequests.js';
import jobRoutes from './jobs.js';
import zeroRfeRoutes from './zeroRfe.js';
import materialRoutes from './material.js';
import pettyCashRoutes from './pettyCash.js';
import lpoRoutes from './lpo.js';
import { runDeadlineSweep } from './deadlines.js';

export { runImport, type RunImportInput, type RunImportResult } from './imports.js';
export { runDeadlineSweep, type SweepResult } from './deadlines.js';
export type { OpsClock } from './context.js';

const SWEEP_MS = 15 * 60 * 1000;

async function opsPlugin(app: FastifyInstance): Promise<void> {
  if (!app.hasDecorator('opsClock')) app.decorate('opsClock', makeClock());
  await app.register(importRoutes);
  await app.register(workRequestRoutes);
  await app.register(jobRoutes);
  await app.register(zeroRfeRoutes);
  await app.register(materialRoutes);
  await app.register(pettyCashRoutes);
  await app.register(lpoRoutes);

  // Deadline sweep every 15 minutes; not in tests (they call runDeadlineSweep directly) and never started twice.
  if (app.config.nodeEnv !== 'test' && process.env.SONU_DEADLINE_SWEEP !== 'off') {
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    app.addHook('onReady', async () => {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        runDeadlineSweep(app)
          .catch((err) => app.log.error({ err: (err as Error).message }, 'deadline sweep failed'))
          .finally(() => {
            running = false;
          });
      }, SWEEP_MS);
      timer.unref();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
      timer = null;
    });
  }
}

export default fp(opsPlugin, { name: 'sonu-ops' });
