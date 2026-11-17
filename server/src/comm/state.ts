/** Shared communication state on the Fastify instance (app.comm). Tests replace its transports with fakes. */
import type { FastifyInstance } from 'fastify';
import type { PushSendFn } from './push.js';
import { webPushSend } from './push.js';
import { WhatsAppManager } from './whatsapp/linked.js';
import { loadBaileys } from './whatsapp/baileys.js';

export interface CommState {
  whatsapp: WhatsAppManager;
  pushSend: PushSendFn;
  /** Clock used by dispatch, quiet hours, rate limits and the scheduler (tests set it). */
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    comm: CommState;
  }
}

export function createCommState(app: FastifyInstance): CommState {
  return {
    whatsapp: new WhatsAppManager(app.db, app.log, { loader: loadBaileys, reconnect: app.config.nodeEnv !== 'test' }),
    pushSend: webPushSend,
    now: () => new Date(),
  };
}
