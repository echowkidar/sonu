/**
 * Marafiq-connection plugin: admin routes, internal worker API, and the scheduler loop
 * (every 60 s; not started when NODE_ENV=test — tests call runSchedulerOnce()).
 */
import type { FastifyInstance } from 'fastify';
import connectionRoutes from './routes.js';
import internalWorkerRoutes from './internal.js';
import { runSchedulerOnce } from './service.js';

export { runSchedulerOnce, claimNextJob, applyJobResult, checkBaseUrl, type ImportRunner } from './service.js';
export { MARAFIQ_LIST_KEYS } from './lists.js';
export { defaultSchedule, effectiveSchedule, dueLists } from './schedule.js';
export const SCHEDULER_INTERVAL_MS = 60_000;

export default async function connectionPlugin(app: FastifyInstance): Promise<void> {
  await app.register(connectionRoutes);
  await app.register(internalWorkerRoutes); // encapsulated: its token hook applies to /internal/* only

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  app.addHook('onReady', async () => {
    if (app.config.nodeEnv === 'test') return;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      runSchedulerOnce(app)
        .catch((err) => app.log.warn({ err: (err as Error).message }, 'connection scheduler run failed'))
        .finally(() => {
          busy = false;
        });
    }, SCHEDULER_INTERVAL_MS);
    timer.unref?.();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
