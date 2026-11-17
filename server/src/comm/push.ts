/**
 * Web push with the stored VAPID keys (startup.ts generates them; private key encrypted in table secret).
 * Subscriptions answering 404 / 410 are removed.
 */
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import type { Queryable } from '../db.js';
import { readSecret } from '../secrets.js';

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
}

/** Transport used to deliver one push (replaced by a fake in tests). */
export type PushSendFn = (sub: PushSubscriptionKeys, payload: string, options: PushOptions) => Promise<{ statusCode: number }>;

export const webPushSend: PushSendFn = async (sub, payload, options) => {
  const res = await webpush.sendNotification(sub, payload, options);
  return { statusCode: res.statusCode };
};

export async function vapidPublicKey(db: Queryable): Promise<string | null> {
  const r = await db.query<{ value: { publicKey?: string } }>(`SELECT value FROM app_setting WHERE key = 'vapid' AND contractor_id IS NULL`);
  return r.rows[0]?.value?.publicKey ?? null;
}

async function vapidDetails(app: FastifyInstance): Promise<PushOptions['vapidDetails'] | null> {
  const r = await app.db.query<{ value: { publicKey?: string; subject?: string }; secret_id: string | null }>(
    `SELECT value, secret_id FROM app_setting WHERE key = 'vapid' AND contractor_id IS NULL`,
  );
  const row = r.rows[0];
  if (!row?.value?.publicKey) return null;
  const privateKey = await readSecret(app.db, row.secret_id, null);
  if (!privateKey) return null;
  const s = row.value.subject ?? app.config.publicUrl;
  // web-push accepts only https: or mailto: subjects.
  const subject = /^(https:|mailto:)/.test(s) ? s : 'mailto:noreply@sonu.invalid';
  return { subject, publicKey: row.value.publicKey, privateKey };
}

export interface PushPayload {
  title: string;
  body?: string | null;
  url?: string | null;
  id?: string;
  event?: string;
}

export interface PushOutcome {
  devices: number;
  sent: number;
  removed: number;
  failed: number;
  lastError: string | null;
}

/** Sends one payload to every device of a user. Never throws for per-device errors. */
export async function pushToUser(app: FastifyInstance, userId: string, payload: PushPayload): Promise<PushOutcome> {
  const subs = await app.db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1',
    [userId],
  );
  const out: PushOutcome = { devices: subs.rows.length, sent: 0, removed: 0, failed: 0, lastError: null };
  if (!subs.rows.length) return out;
  const vapid = await vapidDetails(app);
  if (!vapid) {
    out.failed = subs.rows.length;
    out.lastError = 'web push keys are missing';
    return out;
  }
  const body = JSON.stringify(payload);
  for (const s of subs.rows) {
    try {
      await app.comm.pushSend({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails: vapid, TTL: 24 * 3600 });
      out.sent++;
      await app.db.query('UPDATE push_subscription SET last_used_at = now() WHERE id = $1', [s.id]);
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await app.db.query('DELETE FROM push_subscription WHERE id = $1', [s.id]);
        out.removed++;
      } else {
        out.failed++;
        out.lastError = code ? `push service answered HTTP ${code}` : String((err as Error).message ?? err).split('\n')[0]!.slice(0, 200);
      }
    }
  }
  return out;
}
