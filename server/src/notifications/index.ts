/**
 * Notifications. One call per event; channels follow each recipient's preferences.
 *
 *   await notify(app, {
 *     contractorId, event: 'wr.returned', recipients: [ownerId],
 *     title: 'WR 123456 returned by QF', body: '...', link: '/wr/123456', workRequestId,
 *   });
 *
 * - in_app: always (status 'sent'; read via GET /api/notifications).
 * - email: when the user has notify_email on; sent now through the contractor's MailSender.
 * - push / whatsapp: rows are queued with status 'pending' for the push / WhatsApp dispatchers
 *   (to be built), only when the user opted in and the contractor has the channel on.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { mailTemplates, sendMail } from '../mail/index.js';
import { notFound } from '../errors.js';

export type Channel = 'in_app' | 'email' | 'push' | 'whatsapp';

export interface NotifyInput {
  contractorId: string | null;
  event: string;
  recipients: string[];
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  workRequestId?: string | null;
  template?: string | null;
  /** Restrict to these channels (default: all the user allows). */
  channels?: Channel[];
}

export async function notify(app: FastifyInstance, input: NotifyInput, db: Queryable = app.db): Promise<{ created: number; emailed: number }> {
  if (!input.recipients.length) return { created: 0, emailed: 0 };
  const users = await db.query<{ id: string; email: string; notify_email: boolean; notify_push: boolean; notify_whatsapp: boolean; mobile: string | null }>(
    `SELECT id, email, notify_email, notify_push, notify_whatsapp, mobile FROM app_user
      WHERE id = ANY($1::uuid[]) AND status = 'active' AND contractor_id IS NOT DISTINCT FROM $2`,
    [input.recipients, input.contractorId],
  );
  const pushOn = input.contractorId
    ? ((await db.query<{ push_enabled: boolean }>('SELECT push_enabled FROM messaging_settings WHERE contractor_id = $1', [input.contractorId])).rows[0]?.push_enabled ?? true)
    : false;
  const allowed = (c: Channel) => !input.channels || input.channels.includes(c);
  const emailRows: { id: string; to: string }[] = [];
  let created = 0;
  for (const u of users.rows) {
    const channels: Channel[] = [];
    if (allowed('in_app')) channels.push('in_app');
    if (allowed('email') && u.notify_email) channels.push('email');
    if (allowed('push') && u.notify_push && pushOn) channels.push('push');
    if (allowed('whatsapp') && u.notify_whatsapp && u.mobile) channels.push('whatsapp');
    for (const ch of channels) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO notification (contractor_id, event, entity_type, entity_id, work_request_id, recipient_id, channel, template, title, body, link, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $12 = 'sent' THEN now() END) RETURNING id`,
        [
          input.contractorId, input.event, input.entityType ?? null, input.entityId ?? null, input.workRequestId ?? null, u.id, ch,
          input.template ?? null, input.title, input.body ?? null, input.link ?? null, ch === 'in_app' ? 'sent' : 'pending',
        ],
      );
      created++;
      if (ch === 'email') emailRows.push({ id: r.rows[0]!.id, to: u.email });
    }
  }
  let emailed = 0;
  for (const e of emailRows) {
    try {
      const link = input.link ? `${app.config.publicUrl}${input.link.startsWith('/') ? '' : '/'}${input.link}` : null;
      await sendMail(app, input.contractorId, mailTemplates.notification({ to: e.to, title: input.title, body: input.body ?? null, link }));
      await db.query(`UPDATE notification SET status = 'sent', sent_at = now() WHERE id = $1`, [e.id]);
      emailed++;
    } catch (err) {
      await db.query(`UPDATE notification SET status = 'failed', error = $2 WHERE id = $1`, [e.id, String((err as Error).message).slice(0, 300)]);
    }
  }
  return { created, emailed };
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', { preHandler: requireAuth }, async (request) => {
    const q = z.object({ unread: z.enum(['1', 'true', '0', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const user = currentUser(request);
    const unreadOnly = q.unread === '1' || q.unread === 'true';
    const r = await app.db.query(
      `SELECT id, event, entity_type AS "entityType", entity_id AS "entityId", work_request_id AS "workRequestId", title, body, link,
              created_at AS "createdAt", read_at AS "readAt"
         FROM notification WHERE recipient_id = $1 AND channel = 'in_app' ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC LIMIT $2`,
      [user.id, q.limit],
    );
    const unread = (await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE recipient_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [user.id],
    )).rows[0]!.n;
    return { items: r.rows, unread };
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const r = await app.db.query(
      `UPDATE notification SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_id = $2`,
      [id, currentUser(request).id],
    );
    if (!r.rowCount) throw notFound('Notification not found.');
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: requireAuth }, async (request) => {
    await app.db.query(
      `UPDATE notification SET read_at = now() WHERE recipient_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [currentUser(request).id],
    );
    return { ok: true };
  });
}
