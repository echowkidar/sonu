/**
 * Notifications. One call per event; channels follow each recipient's preferences.
 *
 *   await notify(app, {
 *     contractorId, event: 'wr.returned', userIds: [ownerId],          // or roles: ['coordinator'], workTeamIds
 *     title: 'WR 123456 returned by QF', body: '...', url: '/work-requests/123456',
 *     record: { type: 'work_request', id: wrId, workRequestId: wrId },
 *   });
 *   // Legacy shape still works: { recipients, link, entityType, entityId, workRequestId }.
 *
 * - in_app: always immediate (status 'sent'; read via GET /api/notifications).
 * - email / push / whatsapp: per user preference (notify_email / notify_push / notify_whatsapp; push also needs the
 *   contractor's push switch). During the user's quiet hours they are deferred to the end of the quiet hours.
 *   Delivered at once when possible, otherwise by the dispatcher loop with retry / back-off.
 * - Deadline breaches (alwaysManagerOnBreach, or an event name containing "breach") always reach the contractor's
 *   managers: in-app + e-mail (+ push when they have a device), ignoring opt-outs and quiet hours.
 * - WhatsApp in click-to-chat mode: the in-app item carries the ready wa.me link (data.whatsapp.url).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { ALL_TEAMS_ROLES, type Role } from '../auth/roles.js';
import { notFound } from '../errors.js';
import { quietUntil } from '../comm/time.js';
import { dispatchPending } from './dispatcher.js';

export { dispatchPending, safeError, MAX_ATTEMPTS, BACKOFF_MINUTES } from './dispatcher.js';

export type Channel = 'in_app' | 'email' | 'push' | 'whatsapp';

export interface NotifyInput {
  contractorId: string | null;
  event: string;
  /** Users to tell (ids). */
  userIds?: string[];
  /** Legacy alias of userIds. */
  recipients?: string[];
  /** Everyone of the contractor with one of these roles … */
  roles?: Role[];
  /** … limited to these work teams for team-scoped roles (all-teams roles are always included). */
  workTeamIds?: string[];
  title: string;
  body?: string | null;
  /** Path inside SONU ("/work-requests/123456") or absolute URL. */
  url?: string | null;
  /** Legacy alias of url. */
  link?: string | null;
  record?: { type: string; id: string; workRequestId?: string | null } | null;
  entityType?: string | null;
  entityId?: string | null;
  workRequestId?: string | null;
  template?: string | null;
  /** Restrict to these channels (default: all the user allows). */
  channels?: Channel[];
  /** Deadline breach: always reaches the managers. */
  alwaysManagerOnBreach?: boolean;
}

export interface NotifyResult {
  /** Rows created (all channels). */
  created: number;
  /** E-mails sent during this call. */
  emailed: number;
  /** People told. */
  recipients: number;
  /** Rows deferred by quiet hours. */
  deferred: number;
}

interface UserRow {
  id: string;
  role: Role;
  email: string;
  mobile: string | null;
  notify_email: boolean;
  notify_push: boolean;
  notify_whatsapp: boolean;
  qs: string | null;
  qe: string | null;
}

const USER_COLS = `u.id, u.role, u.email, u.mobile, u.notify_email, u.notify_push, u.notify_whatsapp,
  to_char(u.quiet_hours_start, 'HH24:MI') AS qs, to_char(u.quiet_hours_end, 'HH24:MI') AS qe`;

export function isBreach(input: Pick<NotifyInput, 'event' | 'alwaysManagerOnBreach'>): boolean {
  return !!input.alwaysManagerOnBreach || /breach/i.test(input.event);
}

export async function notify(app: FastifyInstance, input: NotifyInput, db: Queryable = app.db): Promise<NotifyResult> {
  const result: NotifyResult = { created: 0, emailed: 0, recipients: 0, deferred: 0 };
  const ids = [...new Set([...(input.userIds ?? []), ...(input.recipients ?? [])])];
  const users = new Map<string, UserRow>();
  const forced = new Set<string>();

  if (ids.length) {
    const r = await db.query<UserRow>(
      `SELECT ${USER_COLS} FROM app_user u WHERE u.id = ANY($1::uuid[]) AND u.status = 'active' AND u.contractor_id IS NOT DISTINCT FROM $2`,
      [ids, input.contractorId],
    );
    for (const u of r.rows) users.set(u.id, u);
  }
  if (input.contractorId && input.roles?.length) {
    const teams = input.workTeamIds?.length ? input.workTeamIds : null;
    const r = await db.query<UserRow>(
      `SELECT ${USER_COLS} FROM app_user u
        WHERE u.contractor_id = $1 AND u.status = 'active' AND u.role = ANY($2::text[])
          AND ($3::uuid[] IS NULL OR u.role = ANY($4::text[])
               OR EXISTS (SELECT 1 FROM user_work_team t WHERE t.user_id = u.id AND t.work_team_id = ANY($3::uuid[])))`,
      [input.contractorId, input.roles, teams, ALL_TEAMS_ROLES],
    );
    for (const u of r.rows) users.set(u.id, u);
  }
  if (input.contractorId && isBreach(input)) {
    const r = await db.query<UserRow>(
      `SELECT ${USER_COLS} FROM app_user u WHERE u.contractor_id = $1 AND u.status = 'active' AND u.role = 'manager'`,
      [input.contractorId],
    );
    for (const u of r.rows) {
      users.set(u.id, u);
      forced.add(u.id);
    }
  }
  if (!users.size) return result;

  const ctx = input.contractorId
    ? (await db.query<{ push_enabled: boolean | null; time_zone: string }>(
        `SELECT m.push_enabled, c.time_zone FROM contractor c LEFT JOIN messaging_settings m ON m.contractor_id = c.id WHERE c.id = $1`,
        [input.contractorId],
      )).rows[0]
    : undefined;
  const pushOn = !!input.contractorId && (ctx?.push_enabled ?? true);
  const tz = ctx?.time_zone ?? 'Asia/Qatar';
  const now = app.comm.now();
  const url = input.url ?? input.link ?? null;
  const entityType = input.record?.type ?? input.entityType ?? null;
  const entityId = input.record?.id ?? input.entityId ?? null;
  const workRequestId = input.record?.workRequestId ?? input.workRequestId ?? null;
  const data = { ...(url ? { url } : {}), ...(input.record ? { record: input.record } : {}) };
  const allowed = (c: Channel) => !input.channels || input.channels.includes(c);
  const immediate: string[] = [];
  const emailIds: string[] = [];

  const insert = async (userId: string, ch: Channel, status: 'sent' | 'pending', nextAt: Date | null, extra: Record<string, unknown> = {}) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO notification (contractor_id, event, entity_type, entity_id, work_request_id, recipient_id, channel, template, title, body, link,
                                 status, sent_at, next_attempt_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $12 = 'sent' THEN now() END, $13, $14) RETURNING id`,
      [input.contractorId, input.event, entityType, entityId, workRequestId, userId, ch, input.template ?? null, input.title, input.body ?? null, url,
        status, nextAt, JSON.stringify({ ...data, ...extra })],
    );
    result.created++;
    return r.rows[0]!.id;
  };

  for (const u of users.values()) {
    const must = forced.has(u.id);
    let inAppId: string | null = null;
    if (allowed('in_app') || must) inAppId = await insert(u.id, 'in_app', 'sent', null);
    const quiet = must ? null : quietUntil(now, tz, u.qs, u.qe);
    const queue = async (ch: Channel) => {
      const id = await insert(u.id, ch, 'pending', quiet, inAppId ? { inAppId } : {});
      if (quiet) result.deferred++;
      else immediate.push(id);
      if (ch === 'email') emailIds.push(id);
    };
    if ((allowed('email') || must) && (u.notify_email || must)) await queue('email');
    if (allowed('push') && pushOn && (u.notify_push || must)) await queue('push');
    if (allowed('whatsapp') && u.notify_whatsapp && u.mobile && input.contractorId) await queue('whatsapp');
    result.recipients++;
  }

  // Deliver now what is not deferred, unless we are inside the caller's transaction (rows not visible yet):
  // then the dispatcher loop picks them up within seconds.
  if (db === app.db && immediate.length) {
    try {
      await dispatchPending(app, { ids: immediate, limit: immediate.length });
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'immediate notification dispatch failed; the dispatcher will retry');
    }
    if (emailIds.length) {
      result.emailed = (await app.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification WHERE id = ANY($1::uuid[]) AND status = 'sent'`,
        [emailIds],
      )).rows[0]!.n;
    }
  }
  return result;
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', { preHandler: requireAuth }, async (request) => {
    const q = z
      .object({
        unread: z.enum(['1', 'true', '0', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      })
      .parse(request.query);
    const user = currentUser(request);
    const unreadOnly = q.unread === '1' || q.unread === 'true';
    const where = `recipient_id = $1 AND channel = 'in_app' ${unreadOnly ? 'AND read_at IS NULL' : ''}`;
    const r = await app.db.query(
      `SELECT id, event, entity_type AS "entityType", entity_id AS "entityId", work_request_id AS "workRequestId", title, body, link,
              link AS url, data->'whatsapp' AS whatsapp, data->'record' AS record, created_at AS "createdAt", read_at AS "readAt"
         FROM notification WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [user.id, q.limit, q.offset],
    );
    const counts = (await app.db.query<{ total: number; unread: number }>(
      `SELECT count(*) FILTER (WHERE ${unreadOnly ? 'read_at IS NULL' : 'true'})::int AS total,
              count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notification WHERE recipient_id = $1 AND channel = 'in_app'`,
      [user.id],
    )).rows[0]!;
    return { items: r.rows, unread: counts.unread, total: counts.total, limit: q.limit, offset: q.offset };
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const r = await app.db.query(
      `UPDATE notification SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_id = $2 AND channel = 'in_app'`,
      [id, currentUser(request).id],
    );
    if (!r.rowCount) throw notFound('Notification not found.');
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: requireAuth }, async (request) => {
    const r = await app.db.query(
      `UPDATE notification SET read_at = now() WHERE recipient_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [currentUser(request).id],
    );
    return { ok: true, marked: r.rowCount ?? 0 };
  });
}
