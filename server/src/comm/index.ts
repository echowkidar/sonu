/**
 * Communication plugin: app.comm (push transport, WhatsApp manager, clock), the routes, and the
 * notification dispatcher loop (every 15 s; not started when NODE_ENV=test — tests call dispatchPending()).
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { dispatchPending } from '../notifications/dispatcher.js';
import commRoutes from './routes.js';
import { createCommState } from './state.js';

export type { CommState } from './state.js';
export const DISPATCH_INTERVAL_MS = 15_000;

async function commPlugin(app: FastifyInstance): Promise<void> {
  app.decorate('comm', createCommState(app));
  await app.register(commRoutes);

  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  app.addHook('onReady', async () => {
    if (app.config.nodeEnv === 'test') return;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      dispatchPending(app, { limit: 100 })
        .catch((err) => app.log.warn({ err: (err as Error).message }, 'notification dispatcher run failed'))
        .finally(() => {
          busy = false;
        });
    }, DISPATCH_INTERVAL_MS);
    timer.unref?.();
    // Re-open linked WhatsApp sessions that were stored (loads the library only for those contractors).
    const linked = await app.db.query<{ contractor_id: string }>(
      `SELECT contractor_id FROM messaging_settings WHERE whatsapp_mode = 'linked_session' AND wa_session_secret_id IS NOT NULL`,
    );
    for (const r of linked.rows) {
      app.comm.whatsapp.start(r.contractor_id).catch((err) => app.log.warn({ err: (err as Error).message }, 'could not re-open the linked WhatsApp session'));
    }
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    app.comm.whatsapp.stopAll();
  });
}

export default fp(commPlugin, { name: 'sonu-comm' });
