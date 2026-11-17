/** Routes: messaging settings (admin), WhatsApp link / linked-session admin, web push. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { AppError, notFound } from '../errors.js';
import { pushToUser, vapidPublicKey } from './push.js';
import {
  LINKED_SESSION_WARNING, WA_HARD_CAPS, buildWaLink, qrSvg, waSettings, whatsappStatus,
} from './whatsapp/index.js';

const scopeQuery = z.object({ contractorId: z.string().uuid().optional() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

export default async function commRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };

  // ───── Messaging settings ─────
  const messagingView = async (contractorId: string) => {
    await waSettings(app.db, contractorId);
    const r = await app.db.query(
      `SELECT whatsapp_mode AS "whatsappMode", push_enabled AS "pushEnabled",
              to_char(quiet_hours_start, 'HH24:MI') AS "quietHoursStart", to_char(quiet_hours_end, 'HH24:MI') AS "quietHoursEnd",
              wa_min_interval_seconds AS "minIntervalSeconds", wa_daily_limit AS "dailyLimit",
              wa_risk_acknowledged_at AS "riskAcknowledgedAt", updated_at AS "updatedAt"
         FROM messaging_settings WHERE contractor_id = $1`,
      [contractorId],
    );
    const row = r.rows[0];
    const status = await whatsappStatus(app, contractorId, { checkAvailability: row.whatsappMode === 'linked_session', now: app.comm.now() });
    return {
      whatsappMode: row.whatsappMode,
      pushEnabled: row.pushEnabled,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      rateLimit: {
        minIntervalSeconds: row.minIntervalSeconds,
        dailyLimit: row.dailyLimit,
        hardCaps: WA_HARD_CAPS,
      },
      riskWarning: LINKED_SESSION_WARNING,
      riskAcknowledgedAt: row.riskAcknowledgedAt,
      linkedSession: status,
      updatedAt: row.updatedAt,
    };
  };

  app.get('/api/admin/messaging', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    return messagingView(contractorId);
  });

  app.put('/api/admin/messaging', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    const body = z
      .object({
        whatsappMode: z.enum(['click_to_chat', 'linked_session']).optional(),
        acknowledgeRisk: z.boolean().optional(),
        pushEnabled: z.boolean().optional(),
        quietHoursStart: time.nullish(),
        quietHoursEnd: time.nullish(),
        rateLimit: z
          .object({
            minIntervalSeconds: z.number().int().min(WA_HARD_CAPS.minIntervalSecondsMin).max(WA_HARD_CAPS.minIntervalSecondsMax).optional(),
            dailyLimit: z.number().int().min(WA_HARD_CAPS.dailyLimitMin).max(WA_HARD_CAPS.dailyLimitMax).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    const cur = await waSettings(app.db, contractorId);
    const switching = body.whatsappMode !== undefined && body.whatsappMode !== cur.whatsapp_mode;
    if (switching && body.whatsappMode === 'linked_session' && body.acknowledgeRisk !== true) {
      throw new AppError(400, 'risk_not_acknowledged', 'Switching to a linked session needs acknowledgeRisk: true.', { riskWarning: LINKED_SESSION_WARNING });
    }
    const user = currentUser(request);
    await app.db.query(
      `UPDATE messaging_settings SET
         whatsapp_mode = COALESCE($2, whatsapp_mode),
         push_enabled = COALESCE($3, push_enabled),
         quiet_hours_start = CASE WHEN $4::boolean THEN $5::time ELSE quiet_hours_start END,
         quiet_hours_end = CASE WHEN $6::boolean THEN $7::time ELSE quiet_hours_end END,
         wa_min_interval_seconds = COALESCE($8, wa_min_interval_seconds),
         wa_daily_limit = COALESCE($9, wa_daily_limit),
         wa_risk_acknowledged_at = CASE WHEN $10::boolean THEN now() ELSE wa_risk_acknowledged_at END,
         wa_risk_acknowledged_by = CASE WHEN $10::boolean THEN $11::uuid ELSE wa_risk_acknowledged_by END,
         linked_session_state = CASE WHEN $2 = 'click_to_chat' THEN 'off' ELSE linked_session_state END,
         updated_by = $11, updated_at = now()
       WHERE contractor_id = $1`,
      [
        contractorId, body.whatsappMode ?? null, body.pushEnabled ?? null,
        body.quietHoursStart !== undefined, body.quietHoursStart ?? null, body.quietHoursEnd !== undefined, body.quietHoursEnd ?? null,
        body.rateLimit?.minIntervalSeconds ?? null, body.rateLimit?.dailyLimit ?? null,
        switching && body.whatsappMode === 'linked_session', user.id,
      ],
    );
    if (switching && body.whatsappMode === 'click_to_chat') app.comm.whatsapp.stop(contractorId); // keeps the stored session
    if (switching) {
      await auditFromRequest(request, {
        contractorId,
        action: 'messaging.whatsapp_mode',
        entityType: 'messaging_settings',
        entityId: contractorId,
        summary: `WhatsApp mode ${cur.whatsapp_mode} → ${body.whatsappMode}`,
        details: { from: cur.whatsapp_mode, to: body.whatsappMode, riskAcknowledged: body.whatsappMode === 'linked_session' },
      });
    }
    const { acknowledgeRisk: _a, whatsappMode: _m, ...rest } = body;
    if (Object.keys(rest).length) {
      await auditFromRequest(request, { contractorId, action: 'messaging_settings.update', entityType: 'messaging_settings', entityId: contractorId, details: { changes: rest } });
    }
    return messagingView(contractorId);
  });

  // ───── WhatsApp: click-to-chat link (any signed-in contractor user) ─────
  app.get('/api/whatsapp/link', { preHandler: requireAuth }, async (request) => {
    const q = z.object({ to: z.string().trim().min(1).max(40), text: z.string().max(2000).default('') }).parse(request.query);
    const url = buildWaLink(q.to, q.text);
    return { url, qrSvg: await qrSvg(url) };
  });

  // ───── WhatsApp: linked-session admin ─────
  app.get('/api/admin/whatsapp/status', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    return whatsappStatus(app, contractorId, { checkAvailability: true, now: app.comm.now() });
  });

  app.post('/api/admin/whatsapp/link/start', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    const s = await waSettings(app.db, contractorId);
    if (s.whatsapp_mode !== 'linked_session') {
      throw new AppError(409, 'wrong_mode', 'Switch WhatsApp to "linked session" first (Messaging settings).');
    }
    const avail = await app.comm.whatsapp.availability();
    if (!avail.available) throw new AppError(503, 'unavailable', avail.reason ?? 'Linked session is not available on this server.', { state: 'unavailable' });
    const session = await app.comm.whatsapp.start(contractorId);
    await session.waitForProgress(15_000);
    await auditFromRequest(request, { contractorId, action: 'whatsapp.link_start', entityType: 'messaging_settings', entityId: contractorId, summary: `state ${session.state}` });
    const qr = session.state === 'qr_pending' && session.qr ? session.qr : null;
    return {
      state: session.state,
      qrSvg: qr ? await qrSvg(qr) : null,
      expiresAt: qr ? session.qrExpiresAt : null,
      lastError: session.lastError,
    };
  });

  app.post('/api/admin/whatsapp/disconnect', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    await waSettings(app.db, contractorId);
    await app.comm.whatsapp.logout(contractorId);
    await auditFromRequest(request, { contractorId, action: 'whatsapp.disconnect', entityType: 'messaging_settings', entityId: contractorId, summary: 'logged out; stored session wiped' });
    return whatsappStatus(app, contractorId, { now: app.comm.now() });
  });

  // ───── Web push ─────
  app.get('/api/push/public-key', { preHandler: requireAuth }, async () => {
    const publicKey = await vapidPublicKey(app.db);
    if (!publicKey) throw notFound('Web push keys are not set up.');
    return { publicKey };
  });

  app.post('/api/push/subscribe', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const body = z
      .object({
        endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'Push endpoints are https.'),
        expirationTime: z.number().nullish(),
        keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(4).max(100) }),
      })
      .parse(request.body);
    const ua = String(request.headers['user-agent'] ?? '').slice(0, 300) || null;
    await app.db.query(
      `INSERT INTO push_subscription (contractor_id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET contractor_id = EXCLUDED.contractor_id, user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [user.contractorId, user.id, body.endpoint, body.keys.p256dh, body.keys.auth, ua],
    );
    await auditFromRequest(request, { action: 'push.subscribe', entityType: 'push_subscription', summary: new URL(body.endpoint).host });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: requireAuth }, async (request) => {
    const { endpoint } = z.object({ endpoint: z.string().min(1).max(2000) }).parse(request.body);
    const r = await app.db.query('DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2', [endpoint, currentUser(request).id]);
    return { ok: true, removed: r.rowCount ?? 0 };
  });

  app.post('/api/push/test', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const out = await pushToUser(app, user.id, { title: 'SONU test notification', body: 'Push notifications work on this device.', url: '/', event: 'push.test' });
    return out;
  });
}
