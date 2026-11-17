/**
 * Dispatcher: delivers 'pending' e-mail / push / WhatsApp notification rows with retry and back-off.
 * Rows deferred by quiet hours carry next_attempt_at = end of the quiet hours.
 * Errors are stored as short text (first line, no secrets).
 */
import type { FastifyInstance } from 'fastify';
import { getMailSender, mailTemplates } from '../mail/index.js';
import { pushToUser } from '../comm/push.js';
import { quietUntil } from '../comm/time.js';
import { getWhatsAppChannel, normalizeNumber, WaConsentError, WaRateLimitedError } from '../comm/whatsapp/index.js';

export const MAX_ATTEMPTS = 5;
/** Minutes to wait after attempt n (1-based) failed. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
/** A claimed row is re-tried after this lease if the process died while sending. */
const LEASE_MINUTES = 10;

export interface NotificationRow {
  id: string;
  contractor_id: string | null;
  event: string;
  recipient_id: string;
  channel: 'in_app' | 'email' | 'push' | 'whatsapp';
  title: string;
  body: string | null;
  link: string | null;
  attempts: number;
  data: Record<string, unknown>;
}

interface Outcome {
  status: 'sent' | 'skipped';
  note?: string;
  data?: Record<string, unknown>;
}

class Deferred extends Error {
  constructor(public readonly until: Date, reason: string) {
    super(reason);
  }
}

/** Short, secret-free error text. */
export function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  return raw
    .split('\n')[0]!
    .replace(/((?:pass(?:word)?|pwd|token|secret|authorization|auth)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\/\/[^/\s:@]+:[^@\s]+@/g, '//[redacted]@')
    .slice(0, 300);
}

export function absoluteUrl(app: FastifyInstance, link: string | null): string | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  return `${app.config.publicUrl}${link.startsWith('/') ? '' : '/'}${link}`;
}

async function sendOne(app: FastifyInstance, row: NotificationRow): Promise<Outcome> {
  const u = (await app.db.query<{ email: string; mobile: string | null; status: string; notify_whatsapp: boolean; contractor_id: string | null }>(
    'SELECT email, mobile, status, notify_whatsapp, contractor_id FROM app_user WHERE id = $1',
    [row.recipient_id],
  )).rows[0];
  if (!u || u.status !== 'active' || u.contractor_id !== row.contractor_id) return { status: 'skipped', note: 'recipient not active' };
  const url = absoluteUrl(app, row.link);

  if (row.channel === 'email') {
    const sender = await getMailSender(app, row.contractor_id);
    const res = await sender.send(mailTemplates.notification({ to: u.email, title: row.title, body: row.body, link: url }));
    return { status: 'sent', data: { driver: res.driver } };
  }

  if (row.channel === 'push') {
    const out = await pushToUser(app, row.recipient_id, { title: row.title, body: row.body, url: row.link, id: (row.data.inAppId as string) ?? row.id, event: row.event });
    if (out.sent > 0) return { status: 'sent', data: { devices: out.devices, sent: out.sent, removed: out.removed } };
    if (out.devices === 0) return { status: 'skipped', note: 'no push devices' };
    if (out.failed === 0) return { status: 'skipped', note: 'all devices expired (removed)', data: { removed: out.removed } };
    throw new Error(out.lastError ?? 'push failed');
  }

  if (row.channel === 'whatsapp') {
    const to = normalizeNumber(u.mobile);
    if (!u.notify_whatsapp || !to || !row.contractor_id) return { status: 'skipped', note: 'no WhatsApp consent or number' };
    const text = [row.title, row.body, url].filter(Boolean).join('\n');
    const wa = await getWhatsAppChannel(app, row.contractor_id);
    if (wa.sendText) {
      // Company-level quiet hours: no automatic messages from the linked number at night.
      const ms = (await app.db.query<{ qs: string | null; qe: string | null; tz: string }>(
        `SELECT to_char(m.quiet_hours_start, 'HH24:MI') AS qs, to_char(m.quiet_hours_end, 'HH24:MI') AS qe, c.time_zone AS tz
           FROM messaging_settings m JOIN contractor c ON c.id = m.contractor_id WHERE m.contractor_id = $1`,
        [row.contractor_id],
      )).rows[0];
      const until = ms ? quietUntil(app.comm.now(), ms.tz, ms.qs, ms.qe) : null;
      if (until) throw new Deferred(until, 'company quiet hours');
      const res = await wa.sendText(to, text);
      return { status: 'sent', data: { via: 'linked_session', messageId: res.messageId } };
    }
    // Click to chat (or linked session not connected): the in-app item carries the ready link.
    const link = wa.buildLink(to, text);
    const whatsapp = { url: link, to: `+${to}` };
    const inAppId = row.data.inAppId as string | undefined;
    const upd = inAppId
      ? await app.db.query(`UPDATE notification SET data = data || jsonb_build_object('whatsapp', $2::jsonb) WHERE id = $1 AND channel = 'in_app'`, [inAppId, JSON.stringify(whatsapp)])
      : { rowCount: 0 };
    if (!upd.rowCount) {
      await app.db.query(
        `INSERT INTO notification (contractor_id, event, entity_type, entity_id, work_request_id, recipient_id, channel, template, title, body, link, status, sent_at, data)
         SELECT contractor_id, event, entity_type, entity_id, work_request_id, recipient_id, 'in_app', template, title, body, link, 'sent', now(),
                data || jsonb_build_object('whatsapp', $2::jsonb)
           FROM notification WHERE id = $1`,
        [row.id, JSON.stringify(whatsapp)],
      );
    }
    return { status: 'skipped', note: 'click to chat: link added to the in-app item', data: { via: wa.mode === 'linked_session' ? 'fallback_click_to_chat' : 'click_to_chat' } };
  }
  return { status: 'skipped', note: 'nothing to send' };
}

/**
 * Claims due rows and delivers them. `ids` limits the run to these rows (immediate dispatch from notify()).
 * Returns counts per final status.
 */
export async function dispatchPending(app: FastifyInstance, opts: { ids?: string[]; limit?: number } = {}): Promise<{ sent: number; failed: number; retry: number; skipped: number }> {
  const now = app.comm.now();
  const params: unknown[] = [now, opts.limit ?? 50, LEASE_MINUTES];
  let idFilter = '';
  if (opts.ids) {
    if (!opts.ids.length) return { sent: 0, failed: 0, retry: 0, skipped: 0 };
    params.push(opts.ids);
    idFilter = `AND id = ANY($4::uuid[])`;
  }
  const claimed = await app.db.query<NotificationRow>(
    `UPDATE notification SET attempts = attempts + 1, last_attempt_at = $1, next_attempt_at = $1::timestamptz + make_interval(mins => $3::int)
      WHERE id IN (SELECT id FROM notification
                    WHERE status = 'pending' AND channel <> 'in_app' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) ${idFilter}
                    ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, contractor_id, event, recipient_id, channel, title, body, link, attempts, data`,
    params,
  );
  const counts = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  for (const row of claimed.rows) {
    try {
      const out = await sendOne(app, row);
      await app.db.query(
        `UPDATE notification SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, error = NULL,
                next_attempt_at = NULL, data = data || $3::jsonb WHERE id = $1`,
        [row.id, out.status, JSON.stringify({ ...(out.data ?? {}), ...(out.note ? { note: out.note } : {}) })],
      );
      counts[out.status]++;
    } catch (err) {
      if (err instanceof WaConsentError) {
        await app.db.query(`UPDATE notification SET status = 'skipped', next_attempt_at = NULL, error = $2 WHERE id = $1`, [row.id, safeError(err)]);
        counts.skipped++;
        continue;
      }
      if (err instanceof Deferred || err instanceof WaRateLimitedError) {
        const until = err instanceof Deferred ? err.until : err.retryAt;
        // Not a failure: wait for the slot without spending an attempt.
        await app.db.query(`UPDATE notification SET attempts = attempts - 1, next_attempt_at = $2, error = $3 WHERE id = $1`, [row.id, until, safeError(err)]);
        counts.retry++;
        continue;
      }
      const msg = safeError(err);
      if (row.attempts >= MAX_ATTEMPTS) {
        await app.db.query(`UPDATE notification SET status = 'failed', error = $2, next_attempt_at = NULL WHERE id = $1`, [row.id, msg]);
        counts.failed++;
      } else {
        const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)]!;
        await app.db.query(`UPDATE notification SET error = $2, next_attempt_at = $3 WHERE id = $1`, [row.id, msg, new Date(now.getTime() + wait * 60_000)]);
        counts.retry++;
      }
      app.log.warn({ notificationId: row.id, channel: row.channel, attempt: row.attempts, error: msg }, 'notification delivery failed');
    }
  }
  return counts;
}
